def normalize_email(email):
    local, domain = email.strip().split("@", 1)
    return f"{local}@{domain.lower()}"
