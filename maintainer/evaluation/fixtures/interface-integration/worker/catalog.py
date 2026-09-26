ORDERS = {
    "desk": [("pen", 125, 2), ("pad", 75, 1)],
    "mail": [("stamp", 40, 3)],
}


def lines_for_order(order_id):
    return [
        {"sku": sku, "unit_cents": unit_cents, "quantity": quantity}
        for sku, unit_cents, quantity in ORDERS[order_id]
    ]
