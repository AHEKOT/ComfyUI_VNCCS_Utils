import torch


def mean_stdev_masked(input_tensor, is_valid, items_dim, dimensions_dim, fixed_ref=None):
    if fixed_ref is not None:
        mean = fixed_ref
    else:
        mean = reduce_mean_masked(input_tensor, is_valid, dim=items_dim, keepdim=True)
    centered = input_tensor - mean

    n_new_dims = input_tensor.ndim - is_valid.ndim
    is_valid = is_valid.reshape(is_valid.shape + (1,) * n_new_dims)
    n_valid = is_valid.sum(dim=items_dim, keepdim=True, dtype=input_tensor.dtype)

    sum_of_squared_deviations = reduce_sum_masked(
        torch.square(centered), is_valid, dim=(items_dim, dimensions_dim), keepdim=True)

    stdev = torch.sqrt(torch.nan_to_num(sum_of_squared_deviations / n_valid) + 1e-10)
    return mean, stdev


def reduce_mean_masked(input_tensor, is_valid, dim=None, keepdim=False):
    if is_valid is None:
        return torch.mean(input_tensor, dim=dim, keepdim=keepdim)

    if dim is None and not keepdim:
        return torch.masked_select(input_tensor, is_valid).mean()

    n_new_dims = input_tensor.ndim - is_valid.ndim
    is_valid = is_valid.reshape(is_valid.shape + [1] * n_new_dims)
    replaced = torch.where(is_valid, input_tensor, torch.zeros_like(input_tensor))
    sum_valid = replaced.sum(dim=dim, keepdim=keepdim)
    n_valid = is_valid.sum(dim=dim, keepdim=keepdim, dtype=input_tensor.dtype)
    return torch.nan_to_num(sum_valid / n_valid)


def reduce_sum_masked(input_tensor, is_valid, dim=None, keepdim=False):
    if dim is None and not keepdim:
        return torch.masked_select(input_tensor, is_valid).sum()

    n_new_dims = input_tensor.ndim - is_valid.ndim
    is_valid = is_valid.reshape(is_valid.shape + [1] * n_new_dims)
    replaced = torch.where(is_valid, input_tensor, torch.zeros_like(input_tensor))
    return replaced.sum(dim=dim, keepdim=keepdim)


def softmax(target, dim=-1):
    max_along_axis = torch.amax(target, dim=dim, keepdim=True)
    exponentiated = torch.exp(target - max_along_axis)
    denominator = torch.sum(exponentiated, dim=dim, keepdim=True)
    return exponentiated / denominator


def soft_argmax(inp, dim):
    return decode_heatmap(softmax(inp, dim=dim), dim=dim)


def decode_heatmap(inp, dim=-1, output_coord_dim=-1):
    if not isinstance(dim, (tuple, list)):
        dim = [dim]

    # Convert negative axes to the corresponding positive index (e.g. -1 means last axis)
    heatmap_dims = tuple([d if d >= 0 else inp.ndim + d for d in dim])
    result = []
    for d in heatmap_dims:
        other_heatmap_dims = [other_d for other_d in heatmap_dims if other_d != d]
        summed_over_other_heatmap_axes = torch.sum(inp, dim=other_heatmap_dims, keepdim=True)
        coords = linspace(
            0.0, 1.0, inp.shape[d], dtype=inp.dtype, device=summed_over_other_heatmap_axes.device)
        decoded = torch.tensordot(summed_over_other_heatmap_axes, coords, dims=([d], [0]))
        x = torch.unsqueeze(decoded, d)
        for hd in sorted(heatmap_dims, reverse=True):
            x = x.squeeze(hd)
        result.append(x)
    return torch.stack(result, dim=output_coord_dim)


def linspace(start, stop, num, dtype=None, device=None, endpoint=True):
    start = torch.as_tensor(start, device=device, dtype=dtype)
    stop = torch.as_tensor(stop, device=device, dtype=dtype)

    if endpoint:
        if num == 1:
            return torch.mean(torch.stack([start, stop], dim=0), dim=0, keepdim=True)
        else:
            return torch.linspace(start, stop, num, device=device, dtype=dtype)
    else:
        if num > 1:
            step = (stop - start) / num
            return torch.linspace(start, stop - step, num, device=device, dtype=dtype)
        else:
            return torch.linspace(start, stop, num, device=device, dtype=dtype)
