package client

import "encoding/json"

func encode(value any) ([]byte, error) { return json.Marshal(value) }
