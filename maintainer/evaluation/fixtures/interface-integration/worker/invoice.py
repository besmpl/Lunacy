def total_cents(fetch_lines, order_id):
    return sum(row["price_cents"] * row["quantity"]
               for row in fetch_lines(order_id))
