def run_required_check(capability_available, runner):
    if not capability_available:
        return {"status": "skipped", "ran": False, "exitCode": None}
    exit_code = runner()
    return {"status": "passed" if exit_code == 0 else "failed",
            "ran": True, "exitCode": exit_code}
