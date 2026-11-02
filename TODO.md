# Follow-ups (from worker reviews)
- stream: transcoded/cue streams are not seekable — add `?t=<sec>` start offset and have the browser zone reload on seek; consider fMP4 AAC with duration for iPhone lock-screen scrubbing (phase 4).
- CONTRACTS.md stream fmt list → `orig|flac|aac` (opus returns 400).
- matcher rate limiter is per MbClient instance; share one limiter between matcher and meta (both call MusicBrainz).
- cover route: Spotify albums store an http(s) URL in albums.cover_path — /api/cover must redirect/proxy those.
