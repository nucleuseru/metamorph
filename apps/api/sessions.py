from typing import Dict, Any

# In-memory session storage
# Maps session_id -> {"prompt": str, "images": List[bytes]}
sessions: Dict[str, Dict[str, Any]] = {}

# Active PeerConnections
pcs = set()
