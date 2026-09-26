class RequestState:
    def __init__(self):
        self._generation = 0
        self._status = "idle"
        self._value = None

    def start(self):
        self._generation += 1
        self._status = "running"
        self._value = None
        return self._generation

    def cancel(self):
        self._status = "cancelled"

    def complete(self, generation, value):
        if self._status != "running":
            return False
        self._status = "completed"
        self._value = value
        return True

    def snapshot(self):
        return self._generation, self._status, self._value
