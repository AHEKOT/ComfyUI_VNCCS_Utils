# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

from typing import Callable, Optional, Tuple

import torch


def _cycle_over_all_chunks(
    my_chunk: torch.Tensor,
    pg: torch.distributed.ProcessGroup,
    step_fn: Callable[
        [torch.Tensor, int, Optional[torch.distributed.Work], Optional[torch.Tensor]],
        Optional[torch.Tensor],
    ],
):
    next_rank = (pg.rank() + 1) % pg.size()
    prev_rank = (pg.rank() - 1) % pg.size()

    extra_req: Optional[torch.distributed.Work] = None
    dst_extra_chunk: Optional[torch.Tensor] = None

    dst_chunk = torch.empty_like(my_chunk)
    for iter_ in range(pg.size()):
        src_chunk = my_chunk if iter_ == 0 else dst_chunk
        dst_chunk = torch.empty_like(my_chunk)

        if iter_ < pg.size() - 1:
            send_op = torch.distributed.P2POp(
                torch.distributed.isend, src_chunk, next_rank, group=pg
            )
            recv_op = torch.distributed.P2POp(
                torch.distributed.irecv, dst_chunk, prev_rank, group=pg
            )
            reqs = torch.distributed.batch_isend_irecv([send_op, recv_op])
        else:
            reqs = []

        src_extra_chunk = step_fn(
            src_chunk, (pg.rank() - iter_) % pg.size(), extra_req, dst_extra_chunk
        )
        if src_extra_chunk is not None:
            dst_extra_chunk = torch.empty_like(src_extra_chunk)
            send_op = torch.distributed.P2POp(
                torch.distributed.isend, src_extra_chunk, next_rank, group=pg
            )
            recv_op = torch.distributed.P2POp(
                torch.distributed.irecv, dst_extra_chunk, prev_rank, group=pg
            )
            (extra_req,) = torch.distributed.batch_isend_irecv([send_op, recv_op])
        else:
            extra_req = None
            dst_extra_chunk = None

        for req in reqs:
            req.wait()

    return extra_req, dst_extra_chunk


class MemoryEfficientClipLoss(torch.autograd.Function):
    @staticmethod
    def forward(
        ctx: torch.autograd.function.FunctionCtx,
        pg: torch.distributed.ProcessGroup,
        image_features: torch.Tensor,
        text_features: torch.Tensor,
        logit_scale: torch.Tensor,
    ) -> torch.Tensor:
        image_partial_lses_for_me = torch.empty(
            (pg.size(), image_features.shape[0]),
            dtype=torch.float32,
            device=image_features.device,
        )
        text_partial_lses_for_others = torch.empty(
            (pg.size(), text_features.shape[0]),
            dtype=torch.float32,
            device=text_features.device,
        )

        positives: Optional[torch.Tensor] = None

        def my_step(
            incoming: torch.Tensor,
            other_rank: int,
            _req: Optional[torch.distributed.Work],
            _extra: Optional[torch.Tensor],
        ) -> None:
            nonlocal positives
            logits = logit_scale * (image_features @ incoming.T)
            if other_rank == pg.rank():
                positives = torch.diag(logits)
            torch.logsumexp(logits, dim=1, out=image_partial_lses_for_me[other_rank])
            torch.logsumexp(logits, dim=0, out=text_partial_lses_for_others[other_rank])

        _cycle_over_all_chunks(text_features, pg, my_step)

        text_partial_lses_for_me = torch.empty_like(text_partial_lses_for_others)
        torch.distributed.all_to_all_single(
            text_partial_lses_for_me, text_partial_lses_for_others, group=pg
        )

        image_lses_for_me = torch.logsumexp(image_partial_lses_for_me, dim=0)
        text_lses_for_me = torch.logsumexp(text_partial_lses_for_me, dim=0)

        assert positives is not None
        ctx.save_for_backward(
            image_features,
            text_features,
            logit_scale,
            positives,
            image_lses_for_me,
            text_lses_for_me,
        )
        ctx.pg = pg  # type: ignore[attr-defined]

        return (-(2 * positives - image_lses_for_me - text_lses_for_me).mean() / 2).to(
            positives.dtype
        )

    @staticmethod
    def backward(
        ctx: torch.autograd.function.FunctionCtx, *grad_outputs: torch.Tensor
    ) -> Tuple[Optional[torch.Tensor], ...]:
        pg: torch.distributed.ProcessGroup = ctx.pg  # type: ignore[attr-defined]
        image_features: torch.Tensor
        text_features: torch.Tensor
        logit_scale: torch.Tensor
        positives: torch.Tensor
        image_lses_for_me: torch.Tensor
        text_lses_for_me: torch.Tensor
        (
            image_features,
            text_features,
            logit_scale,
            positives,
            image_lses_for_me,
            text_lses_for_me,
        ) = ctx.saved_tensors  # type: ignore[attr-defined]

        (grad,) = grad_outputs
        grad /= 2 * positives.numel()

        text_lse_for_others = text_lses_for_me.new_empty(
            (pg.size(),) + text_lses_for_me.shape
        )
        torch.distributed.all_gather_into_tensor(
            text_lse_for_others, text_lses_for_me, group=pg
        )

        grad_image_features = torch.zeros_like(image_features)
        grad_logit_scale = torch.zeros_like(logit_scale)

        def my_step(
            incoming: torch.Tensor,
            other_rank: int,
            req: Optional[torch.distributed.Work],
            grad_text_features: Optional[torch.Tensor],
        ) -> torch.Tensor:
            raw_logits = image_features @ incoming.T
            logits = logit_scale * raw_logits

            grad_logits = (
                (logits - image_lses_for_me[:, None]).exp()
                + (logits - text_lse_for_others[other_rank, None, :]).exp()
            ).to(logits.dtype)
            if other_rank == pg.rank():
                torch.diagonal(grad_logits).sub_(2)

            grad_logit_scale.add_((raw_logits * grad_logits).sum())
            grad_raw_logits = grad_logits * logit_scale

            grad_image_features.addmm_(grad_raw_logits, incoming)
            if req is None:
                grad_text_features = torch.matmul(grad_raw_logits.T, image_features)
            else:
                req.wait()
                assert grad_text_features is not None
                grad_text_features.addmm_(grad_raw_logits.T, image_features)

            return grad_text_features

        req, grad_text_features = _cycle_over_all_chunks(text_features, pg, my_step)
        req.wait()

        return (
            None,
            grad * grad_image_features,
            grad * grad_text_features,
            grad * grad_logit_scale,
        )


def memory_efficient_clip_loss(
    image_features: torch.Tensor,
    text_features: torch.Tensor,
    logit_scale: torch.Tensor,
    *,
    group: torch.distributed.ProcessGroup,
) -> torch.Tensor:
    return MemoryEfficientClipLoss.apply(
        group, image_features.float(), text_features.float(), logit_scale.float()
    )
