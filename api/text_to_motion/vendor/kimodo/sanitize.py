# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Text prompt sanitization for motion generation (whitespace, punctuation, capitalization)."""


def sanitize_text(text: str, paragraph: bool = True) -> str:
    """Sanitize a text prompt: strip, collapse spaces, capitalize, trim non-alphanumeric, add/fix final punctuation.

    Args:
        text: Input text prompt.
        paragraph: If True, capitalize after each sentence break and normalize spacing between sentences.

    Returns:
        Sanitized text.
    """
    # remove any trailing or leading whitespace
    text = text.strip()

    # https://stackoverflow.com/a/1546251
    # replace duplicate spaces by one space
    text = " ".join(text.split())

    if text == "":
        return text

    # removing leading non alpha numeric characters
    for i, c in enumerate(text):
        if not str.isalnum(c):
            continue
        break
    text = text[i:]

    # Capitalize
    text = text.capitalize()

    final_punctuations = ".!?\"])'"
    # removing trailing non alpha numeric characters
    # expect final punctuations
    for i, c in reversed(list(enumerate(text))):
        if not str.isalnum(c) and c not in final_punctuations:
            continue
        break
    text = text[: i + 1]

    # Adding period at the end if needed
    if text[-1] not in ".!?":
        text = text + "."

    if paragraph:
        # fix end of sentences if several sentences
        for sentence_break in ".!?":
            subtexts = text.split(sentence_break)
            text = f"{sentence_break} ".join(  # put back a space after the break
                [
                    y[0].capitalize() + y[1:]  # only capitalize the first character
                    if y
                    else y  # y is empty at the end
                    for x in subtexts
                    for y in [x.strip()]  # remove extra spaces
                ]
            ).strip()  # remove extra space at the end
    return text


def sanitize_texts(texts: list[str]) -> list[str]:
    """Sanitize each text prompt in the list (see sanitize_text).

    Args:
        texts: List of input text prompts.

    Returns:
        List of sanitized texts.
    """
    return [sanitize_text(text) for text in texts]


if __name__ == "__main__":
    texts = [
        " A person is    walking.",
        "someone go forward",
        "jump",
        "jumping!",
        "jumping)",
        "-go",
        "blocasdji  -----",
        "",
    ]

    print("Old texts")
    print("\n".join(texts))
    print()

    new_texts = sanitize_texts(texts)
    print("Sanitized texts")
    print("\n".join(new_texts))
