from catalog import fetch_page


def list_names(names, limit=2):
    first = fetch_page(names, limit=limit)
    result = list(first.names)
    if first.next_cursor is not None:
        result.extend(fetch_page(names, cursor=first.next_cursor, limit=limit).names)
    return result
