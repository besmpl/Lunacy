import hashlib


def classify_check(artifact_path, evidence):
    if evidence is None:
        return "unknown"
    digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    if evidence.get("artifactSha256") != digest:
        return "stale"
    if evidence.get("exitCode") == 0:
        return "applicable"
    return "failed"
