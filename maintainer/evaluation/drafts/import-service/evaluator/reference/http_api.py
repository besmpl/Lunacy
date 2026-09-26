"""WSGI customer import endpoint; the caller owns the database and input stream."""

import json
import re

from service import import_customers


_SPACE = r"[ \t\r\n\f\v]*"
_MEDIA = re.compile(
    _SPACE + r"(application/json|text/csv)" + _SPACE
    + r"(?:;" + _SPACE + r"charset" + _SPACE + "=" + _SPACE + r"utf-8" + _SPACE + r")?",
    re.IGNORECASE | re.ASCII,
)


def _format_for_media_type(value):
    match = _MEDIA.fullmatch(value)
    if match is None:
        return None
    return "json" if match[1].lower() == "application/json" else "csv"


def _body_length(value):
    if not value or any(char < "0" or char > "9" for char in value):
        return None
    length = 0
    for char in value:
        length = length * 10 + ord(char) - ord("0")
    return length


def _respond(start_response, status, result):
    body = (json.dumps(result) + "\n").encode("utf-8")
    start_response(status, [("Content-Type", "application/json"), ("Content-Length", str(len(body)))])
    return [body]


def _invalid(start_response):
    return _respond(start_response, "400 Bad Request", {
        "status": "invalid", "errors": [{"row": 0, "code": "INVALID_INPUT"}],
    })


def application(environ, start_response):
    if environ.get("PATH_INFO") != "/imports":
        return _respond(start_response, "404 Not Found", {"status": "error", "code": "NOT_FOUND"})
    if environ.get("REQUEST_METHOD") != "POST":
        return _respond(start_response, "405 Method Not Allowed", {"status": "error", "code": "METHOD_NOT_ALLOWED"})
    format = _format_for_media_type(environ.get("CONTENT_TYPE", ""))
    if format is None:
        return _respond(start_response, "415 Unsupported Media Type", {"status": "error", "code": "UNSUPPORTED_MEDIA_TYPE"})
    length = _body_length(environ.get("CONTENT_LENGTH", ""))
    if length is None:
        return _invalid(start_response)
    chunks = []
    remaining = length
    while remaining:
        chunk = environ["wsgi.input"].read(min(remaining, 65536))
        if not chunk:
            return _invalid(start_response)
        chunks.append(chunk)
        remaining -= len(chunk)
    body = b"".join(chunks)
    try:
        payload = body.decode("utf-8")
    except UnicodeDecodeError:
        return _invalid(start_response)
    result = import_customers(environ["lunacy.database"], payload, format)
    status = "200 OK" if result["status"] == "ok" else "400 Bad Request"
    return _respond(start_response, status, result)
