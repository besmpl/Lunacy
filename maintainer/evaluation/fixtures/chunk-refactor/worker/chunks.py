def chunk(values, size):
    if size <= 0:
        raise ValueError("size must be positive")
    return [values[index:index + size] for index in range(0, len(values), size)]


def count_chunks(length, size):
    if size <= 0:
        raise ValueError("size must be positive")
    if length < 0:
        raise ValueError("length must not be negative")
    return length // size + 1
