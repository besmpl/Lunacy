def _positive_size(size):
    if size <= 0:
        raise ValueError("size must be positive")
    return size


def chunk(values, size):
    size = _positive_size(size)
    return [values[index:index + size] for index in range(0, len(values), size)]


def count_chunks(length, size):
    size = _positive_size(size)
    if length < 0:
        raise ValueError("length must not be negative")
    return (length + size - 1) // size
