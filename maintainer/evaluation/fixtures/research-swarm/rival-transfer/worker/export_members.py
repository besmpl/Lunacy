def export_members(api, team_id):
    response = api.list_members(team_id=team_id, cursor=None, limit=2)
    return [
        member["email"]
        for member in response["members"]
        if member["active"]
    ]
