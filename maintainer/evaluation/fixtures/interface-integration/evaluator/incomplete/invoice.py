def total_cents(fetch_lines, order_id):
    total = 0
    for row in fetch_lines(order_id):
        unit_cents = row["unit_cents"] if "unit_cents" in row else row["price_cents"]
        total += unit_cents * row["quantity"]
    return total
