CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL CHECK (length(btrim(password_hash)) > 0),
    display_name VARCHAR(64) NOT NULL CHECK (display_name ~ '[^[:space:]]'),
    status_message VARCHAR(280),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_username_format CHECK (username ~ '^[A-Za-z0-9_]{1,64}$')
);

-- Preserve username casing for display; compare lowercase ASCII for identity.
CREATE UNIQUE INDEX users_username_lower_unique ON users (lower(username COLLATE "C"));

CREATE FUNCTION set_user_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = statement_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_user_updated_at();

CREATE TABLE chat_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
    name VARCHAR(100),
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    direct_user_low UUID REFERENCES users(id) ON DELETE RESTRICT,
    direct_user_high UUID REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chat_rooms_metadata CHECK (
        (kind = 'direct' AND name IS NULL
            AND direct_user_low IS NOT NULL AND direct_user_high IS NOT NULL
            AND direct_user_low < direct_user_high
            AND created_by IN (direct_user_low, direct_user_high))
        OR
        (kind = 'group' AND name IS NOT NULL AND name ~ '[^[:space:]]'
            AND direct_user_low IS NULL AND direct_user_high IS NULL)
    ),
    CONSTRAINT chat_rooms_direct_pair_unique UNIQUE (direct_user_low, direct_user_high)
);

CREATE TABLE room_members (
    room_id UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at TIMESTAMPTZ,
    PRIMARY KEY (room_id, user_id),
    CONSTRAINT room_members_leave_time CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE INDEX room_members_user_rooms ON room_members (user_id, room_id);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE RESTRICT,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    content TEXT NOT NULL CHECK (content ~ '[^[:space:]]'),
    client_id VARCHAR(128) NOT NULL CHECK (client_id ~ '[^[:space:]]'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messages_sender_membership FOREIGN KEY (room_id, sender_id)
        REFERENCES room_members(room_id, user_id) ON DELETE RESTRICT,
    CONSTRAINT messages_sender_client_unique UNIQUE (sender_id, client_id)
);

CREATE INDEX messages_room_history ON messages (room_id, created_at, id);
