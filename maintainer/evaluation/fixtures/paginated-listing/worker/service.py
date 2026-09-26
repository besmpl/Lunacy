from catalog import fetch_page


def list_names(names, limit=2):
    return list(fetch_page(names, limit=limit).names)
