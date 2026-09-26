def classify_check(artifact_path, evidence):
    if evidence is None:
        return "unknown"
    if evidence.get("exitCode") == 0:
        return "applicable"
    return "failed"
