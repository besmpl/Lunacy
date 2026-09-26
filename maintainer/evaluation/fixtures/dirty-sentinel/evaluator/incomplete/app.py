def total(quantity, unit_price):
    if quantity < 0:
        raise ValueError("quantity must not be negative")
    return quantity * unit_price
