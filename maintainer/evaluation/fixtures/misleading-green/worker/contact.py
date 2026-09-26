def normalize_email(email):
    local, domain = email.split("@", 1)
    return f"{local}@{domain.lower()}"
