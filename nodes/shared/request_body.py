"""Size limits for HTTP request bodies with or without a declared length."""


async def limit_request_body(request, max_bytes):
    """Return a readable request, or None if the body exceeds the limit."""
    raw_length = request.headers.get("Content-Length")
    if raw_length is not None:
        try:
            return request if 0 <= int(raw_length) <= max_bytes else None
        except (ValueError, TypeError):
            return None
    if not getattr(request, "can_read_body", False):
        return request

    from aiohttp import web

    # Allow the exact route limit on aiohttp versions with an exclusive read limit.
    read_limit = min(max_bytes + 1, request.client_max_size or max_bytes + 1)
    limited = request.clone(client_max_size=read_limit)
    try:
        body = await limited.read()
    except web.HTTPRequestEntityTooLarge:
        return None
    return limited if len(body) <= max_bytes else None
