import hashlib


def classify_check(artifact_path, evidence):
    if evidence is None:
        return "unknown"
    digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    if evidence.get("artifactSha256") != digest:
        return "stale"
    exit_code = evidence.get("exitCode")
    if exit_code is None:
        return "unknown"
    if exit_code == 0:
        return "applicable"
    return "failed"
