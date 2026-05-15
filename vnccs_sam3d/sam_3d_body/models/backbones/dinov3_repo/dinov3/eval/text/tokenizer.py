# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

from typing import List, Union

import torch
from dinov3.thirdparty.CLIP.clip.simple_tokenizer import SimpleTokenizer


class Tokenizer(SimpleTokenizer):
    def __init__(self, vocab_path: str):
        SimpleTokenizer.__init__(self, bpe_path=vocab_path)

    def tokenize(
        self, texts: Union[str, List[str]], context_length: int = 77
    ) -> torch.LongTensor:
        """
        Returns the tokenized representation of given input string(s)

        Parameters
        ----------
        texts : Union[str, List[str]]
            An input string or a list of input strings to tokenize
        context_length : int
            The context length to use; all CLIP models use 77 as the context length

        Returns
        -------
        A two-dimensional tensor containing the resulting tokens, shape = [number of input strings, context_length]
        """
        if isinstance(texts, str):
            texts = [texts]
        sot_token = self.encoder["<|startoftext|>"]
        eot_token = self.encoder["<|endoftext|>"]
        all_tokens = [[sot_token] + self.encode(text) + [eot_token] for text in texts]
        result = torch.zeros(len(all_tokens), context_length, dtype=torch.long)

        for i, tokens in enumerate(all_tokens):
            if len(tokens) > context_length:
                tokens = tokens[:context_length]  # Truncate
                tokens[-1] = eot_token
            result[i, : len(tokens)] = torch.tensor(tokens)

        return result


def get_tokenizer(bpe_path_or_url: str) -> Tokenizer | None:
    import urllib
    from io import BytesIO

    from .tokenizer import Tokenizer

    if urllib.parse.urlparse(bpe_path_or_url).scheme:
        try:
            with urllib.request.urlopen(bpe_path_or_url) as response:
                file_buf = BytesIO(response.read())
                return Tokenizer(vocab_path=file_buf)
        except Exception as e:
            raise FileNotFoundError(
                f"Failed to download file from url {bpe_path_or_url} with error last: {e}"
            )
    else:
        with open(bpe_path_or_url, "rb") as f:
            file_buf = BytesIO(f.read())
            return Tokenizer(vocab_path=file_buf)
