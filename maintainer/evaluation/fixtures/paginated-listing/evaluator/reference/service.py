from catalog import fetch_page


def list_names(names, limit=2):
    result = []
    cursor = None
    while True:
        page = fetch_page(names, cursor=cursor, limit=limit)
        result.extend(page.names)
        if page.next_cursor is None:
            return result
        cursor = page.next_cursor
