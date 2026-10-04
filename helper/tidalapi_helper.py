#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import base64
import json
import os
import pathlib
import unicodedata
import shutil
import sys
import time
import traceback
import xml.etree.ElementTree as ET
from uuid import uuid4
from typing import Any, Callable

import requests
import tidalapi
from tidal_dl_ng.helper.decryption import decrypt_file, decrypt_security_token
from tidalapi.exceptions import TooManyRequests


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload), flush=True)


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    return json.loads(raw)


def quality_from_input(value: str | None) -> str:
    if value == "LOW":
        return tidalapi.Quality.low_96k
    if value == "HIGH":
        return tidalapi.Quality.low_320k
    if value == "LOSSLESS":
        return tidalapi.Quality.high_lossless
    if value == "HI_RES" or value == "MAX" or value == "HI_RES_LOSSLESS":
        return tidalapi.Quality.hi_res_lossless
    return tidalapi.Quality.low_320k


def make_session(payload: dict[str, Any]) -> tidalapi.Session:
    config = tidalapi.Config(quality=quality_from_input(payload.get("preferredQuality")), item_limit=10000)
    session = tidalapi.Session(config=config)
    return session


def session_snapshot(session: tidalapi.Session) -> dict[str, Any]:
    expires_at = None
    if session.expiry_time is not None:
        expires_at = int(session.expiry_time.timestamp() * 1000)

    user_id = None
    if session.user is not None and getattr(session.user, "id", None) is not None:
        user_id = str(session.user.id)

    return {
      "accessToken": session.access_token,
      "refreshToken": session.refresh_token,
      "expiresAt": expires_at,
      "tokenType": session.token_type or "Bearer",
      "scopes": ["r_usr", "w_usr", "w_sub"],
      "countryCode": session.country_code or "US",
      "userId": user_id,
      "isPkce": bool(getattr(session, "is_pkce", False)),
      "sessionId": session.session_id,
    }


def load_session(payload: dict[str, Any]) -> tidalapi.Session:
    session = make_session(payload)
    stored = payload.get("session")
    if not isinstance(stored, dict):
        raise RuntimeError("Missing stored TIDAL session")

    expires_at = stored.get("expiresAt")
    expiry_time = None
    if isinstance(expires_at, int) or isinstance(expires_at, float):
        expiry_time = dt.datetime.utcfromtimestamp(expires_at / 1000)

    ok = session.load_oauth_session(
        token_type=stored.get("tokenType") or "Bearer",
        access_token=stored.get("accessToken"),
        refresh_token=stored.get("refreshToken"),
        expiry_time=expiry_time,
        is_pkce=bool(stored.get("isPkce", False)),
    )
    if not ok:
        raise RuntimeError("Stored TIDAL session is invalid or expired")
    return session


def resource_image_url(image_id: Any, size: int = 640) -> str | None:
    if image_id is None:
        return None
    raw = str(image_id).strip()
    if not raw:
        return None
    return f"https://resources.tidal.com/images/{raw.replace('-', '/')}/{size}x{size}.jpg"


def safe_artist_image_url(artist: Any) -> str | None:
    try:
        url = artist.image(750)
        if isinstance(url, str) and url.strip():
            return url
    except Exception:
        pass

    picture = getattr(artist, "picture", None)
    if picture is None:
        picture = getattr(artist, "picture_id", None)
    return resource_image_url(picture, 750)


def safe_album_image_url(album: Any) -> str | None:
    try:
        url = album.image(640)
        if isinstance(url, str) and url.strip():
            return url
    except Exception:
        pass

    return resource_image_url(getattr(album, "cover", None), 640)


def serialize_genres(entity: Any) -> list[str]:
    genres: list[str] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        if value is None:
            return
        if isinstance(value, dict):
            for key in ("name", "title", "value", "id"):
                if key in value:
                    add(value.get(key))
            return
        if isinstance(value, (list, tuple, set)):
            for item in value:
                add(item)
            return

        raw = str(value).strip()
        if not raw:
            return
        key = normalize_text(raw)
        if key in seen:
            return
        seen.add(key)
        genres.append(raw)

    for attr in (
        "genres",
        "genre",
        "genre_names",
        "genreNames",
        "music_genres",
        "musicGenres",
        "categories",
    ):
        add(getattr(entity, attr, None))

    return genres


def add_payload_genre(payload: dict[str, Any] | None, genre: str | None) -> None:
    if not payload or not genre:
        return
    raw = str(genre).strip()
    if not raw:
        return
    existing = payload.get("genres")
    if not isinstance(existing, list):
        existing = []
        payload["genres"] = existing
    seen = {normalize_text(item) for item in existing if isinstance(item, str)}
    key = normalize_text(raw)
    if key not in seen:
        existing.append(raw)


def serialize_artist(artist: Any) -> dict[str, Any]:
    picture = getattr(artist, "picture", None)
    if picture is None:
        picture = getattr(artist, "picture_id", None)

    return {
      "provider": "tidal",
      "id": str(getattr(artist, "id")),
      "sourceId": str(getattr(artist, "id")),
      "name": getattr(artist, "name", "Unknown Artist"),
      "picture": picture,
      "artworkUrl": safe_artist_image_url(artist),
      "providerUrl": getattr(artist, "share_url", None),
      "genres": serialize_genres(artist),
    }


def serialize_album(album: Any) -> dict[str, Any]:
    release_date = getattr(album, "release_date", None)
    artwork_url = safe_album_image_url(album)
    return {
      "provider": "tidal",
      "id": str(getattr(album, "id")),
      "sourceId": str(getattr(album, "id")),
      "title": getattr(album, "name", "Unknown Album"),
      "cover": getattr(album, "cover", None),
      "artworkUrl": artwork_url,
      "releaseDate": release_date.isoformat() if release_date else None,
      "numberOfTracks": getattr(album, "num_tracks", None),
      "numberOfVolumes": getattr(album, "num_volumes", None),
      "artists": [serialize_artist(artist) for artist in (getattr(album, "artists", None) or [])],
      "artist": serialize_artist(getattr(album, "artist")) if getattr(album, "artist", None) else None,
      "primaryArtistName": getattr(getattr(album, "artist", None), "name", None),
      "providerUrl": getattr(album, "share_url", None),
      "genres": serialize_genres(album),
    }


def serialize_track(track: Any) -> dict[str, Any]:
    album = getattr(track, "album", None)
    artwork_url = safe_album_image_url(album) if album else None
    quality_hint = infer_track_quality_hint(track)
    return {
      "provider": "tidal",
      "id": str(getattr(track, "id")),
      "sourceId": str(getattr(track, "id")),
      "title": getattr(track, "title", "Unknown Track"),
      "duration": getattr(track, "duration", 0),
      "audioQuality": quality_hint,
      "trackNumber": getattr(track, "track_num", None),
      "volumeNumber": getattr(track, "volume_num", None),
      "artists": [serialize_artist(artist) for artist in (getattr(track, "artists", None) or [])],
      "artist": serialize_artist(getattr(track, "artist")) if getattr(track, "artist", None) else None,
      "album": serialize_album(album) if album else None,
      "artworkUrl": artwork_url,
      "providerUrl": getattr(track, "share_url", None),
      "genres": serialize_genres(track),
    }


def title_case_role(role: str | None) -> str | None:
    if role is None:
        return None
    normalized = " ".join(str(role).replace("_", " ").replace("-", " ").split()).strip()
    if not normalized:
        return None
    return normalized.title()


def append_contributor_role(
    groups: dict[str, list[str]],
    role: str | None,
    name: str | None,
) -> None:
    normalized_role = title_case_role(role)
    normalized_name = str(name or "").strip()
    if not normalized_role or not normalized_name:
        return
    bucket = groups.setdefault(normalized_role, [])
    if normalized_name not in bucket:
        bucket.append(normalized_name)


def extract_track_contributor_groups(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        entries = payload.get("items")
        if not isinstance(entries, list):
            entries = payload.get("contributors")
        if not isinstance(entries, list):
            entries = payload.get("credits")
        if not isinstance(entries, list):
            entries = [payload]
    elif isinstance(payload, list):
        entries = payload
    else:
        entries = []

    grouped: dict[str, list[str]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue

        grouped_role = entry.get("role") or entry.get("type") or entry.get("category")
        nested = entry.get("contributors")
        if not isinstance(nested, list):
            nested = entry.get("items")

        if isinstance(nested, list):
            for contributor in nested:
                if not isinstance(contributor, dict):
                    continue
                append_contributor_role(
                    grouped,
                    contributor.get("role") or grouped_role,
                    contributor.get("name") or contributor.get("artistName") or contributor.get("artist"),
                )
            continue

        append_contributor_role(
            grouped,
            grouped_role,
            entry.get("name") or entry.get("artistName") or entry.get("artist"),
        )

    return [
        {"role": role, "contributors": names}
        for role, names in grouped.items()
        if names
    ]


def fetch_track_contributors_payload(track: Any) -> list[dict[str, Any]]:
    for endpoint in (f"tracks/{track.id}/contributors", f"tracks/{track.id}/credits"):
        try:
            response = track.requests.request("GET", endpoint)
            return extract_track_contributor_groups(response.json())
        except Exception:
            continue
    return []


def fetch_album_raw(track: Any) -> dict[str, Any]:
    album = getattr(track, "album", None)
    album_id = getattr(album, "id", None)
    if album_id is None:
        return {}
    try:
        response = track.requests.request("GET", f"albums/{album_id}")
        data = response.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def serialize_playlist(playlist: Any, items: list[dict[str, Any]]) -> dict[str, Any]:
    last_updated = getattr(playlist, "last_updated", None)
    return {
      "uuid": str(getattr(playlist, "id", "")) or None,
      "id": str(getattr(playlist, "id", "")) or None,
      "title": getattr(playlist, "name", "Playlist"),
      "name": getattr(playlist, "name", "Playlist"),
      "numberOfTracks": getattr(playlist, "num_tracks", len(items)),
      "squareImage": getattr(playlist, "square_picture", None) or getattr(playlist, "picture", None),
      "image": getattr(playlist, "picture", None),
      "lastUpdated": last_updated.isoformat() if last_updated else None,
      "items": items,
    }


def normalize_tidal_trn_id(value: Any, prefix: str) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    marker = f"trn:{prefix}:"
    if marker in raw:
        return raw.split(marker, 1)[1].split(":", 1)[0].strip() or None
    return raw


def first_tidal_value(entry: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        value = entry.get(key)
        if value is not None:
            return value
    data = entry.get("data")
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if value is not None:
                return value
    item = entry.get("item")
    if isinstance(item, dict):
        for key in keys:
            value = item.get(key)
            if value is not None:
                return value
    return None


def tidal_folder_item_kind(entry: dict[str, Any]) -> str:
    values = [
      entry.get("type"),
      entry.get("itemType"),
      entry.get("contentType"),
      entry.get("trn"),
      entry.get("uuid"),
      entry.get("id"),
    ]
    data = entry.get("data")
    if isinstance(data, dict):
        values.extend([data.get("itemType"), data.get("type"), data.get("trn"), data.get("uuid"), data.get("id")])
    item = entry.get("item")
    if isinstance(item, dict):
        values.extend([item.get("itemType"), item.get("type"), item.get("trn"), item.get("uuid"), item.get("id")])
    haystack = " ".join(str(value or "") for value in values).upper()
    if "FOLDER" in haystack:
        return "folder"
    if "PLAYLIST" in haystack:
        return "playlist"
    return ""


def tidal_folder_items(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    for key in ("items", "data", "entries"):
        items = payload.get(key)
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
    nested = payload.get("folders")
    if isinstance(nested, dict):
        items = nested.get("items")
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
    return []


def fetch_tidal_playlist_folder_json(
    session: tidalapi.Session,
    path: str,
    params: dict[str, Any],
    fallback_params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        response = session.request.request(
          "GET",
          path,
          params=params,
          base_url=session.config.api_v2_location,
        )
    except Exception:
        if fallback_params is None:
            raise
        response = session.request.request(
          "GET",
          path,
          params=fallback_params,
          base_url=session.config.api_v2_location,
        )
    data = response.json()
    return data if isinstance(data, dict) else {}


def fetch_tidal_playlist_folder_page(session: tidalapi.Session, folder_id: str, cursor: str | None = None) -> dict[str, Any]:
    folder_id = folder_id or "root"
    params = {
      "folderId": folder_id,
      "cursor": cursor,
      "limit": 50,
      "playlistTypes": "FOLDER,PLAYLIST,USER_PLAYLIST,FAVORITE_PLAYLIST",
      "sortBy": "DATE",
      "descending": True,
      "locale": "en_US",
      "deviceType": "DESKTOP",
    }
    fallback_params = {
      "folderId": folder_id,
      "cursor": cursor,
      "limit": 50,
      "includeOnly": None,
      "order": "DATE",
      "orderDirection": "DESC",
      "locale": "en_US",
      "deviceType": "DESKTOP",
    }
    return fetch_tidal_playlist_folder_json(
      session,
      "my-collection/playlists/folders",
      params,
      fallback_params,
    )


def fetch_tidal_playlist_folder_flattened_page(session: tidalapi.Session, cursor: str | None = None) -> dict[str, Any]:
    params = {
      "cursor": cursor,
      "limit": 50,
      "playlistTypes": "FOLDER,PLAYLIST,USER_PLAYLIST,FAVORITE_PLAYLIST",
      "sortBy": "DATE",
      "descending": True,
      "locale": "en_US",
      "deviceType": "DESKTOP",
    }
    fallback_params = {
      "folderId": "root",
      "cursor": cursor,
      "limit": 50,
      "includeOnly": None,
      "order": "DATE",
      "orderDirection": "DESC",
      "locale": "en_US",
      "deviceType": "DESKTOP",
    }
    return fetch_tidal_playlist_folder_json(
      session,
      "my-collection/playlists/folders/flattened",
      params,
      fallback_params,
    )


def fetch_tidal_playlist_folder_items(
    session: tidalapi.Session,
    fetch_page: Callable[[str | None], dict[str, Any]],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    cursor: str | None = None
    seen_cursors: set[str] = set()

    for _ in range(20):
        payload = fetch_page(cursor)
        items.extend(tidal_folder_items(payload))
        next_cursor = payload.get("cursor")
        if not isinstance(next_cursor, str) or not next_cursor.strip() or next_cursor in seen_cursors:
            break
        cursor = next_cursor
        seen_cursors.add(cursor)

    return items


def fetch_tidal_playlist_folder_page_items(session: tidalapi.Session, folder_id: str) -> list[dict[str, Any]]:
    return fetch_tidal_playlist_folder_items(
      session,
      lambda cursor: fetch_tidal_playlist_folder_page(session, folder_id, cursor),
    )


def fetch_tidal_playlist_folder_flattened_items(session: tidalapi.Session) -> list[dict[str, Any]]:
    return fetch_tidal_playlist_folder_items(
      session,
      lambda cursor: fetch_tidal_playlist_folder_flattened_page(session, cursor),
    )


def normalize_tidal_folder_parent(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id") or value.get("trn") or value.get("uuid")
    parent = normalize_tidal_trn_id(value, "folder")
    if not parent or parent == "root":
        return None
    return parent


def parse_tidal_playlist_folder_entries(entries: list[dict[str, Any]]) -> dict[str, Any]:
    folders: list[dict[str, Any]] = []
    playlist_folders: dict[str, dict[str, Any]] = {}

    for index, entry in enumerate(entries):
        kind = tidal_folder_item_kind(entry)
        parent_id = normalize_tidal_folder_parent(first_tidal_value(entry, ["parent", "parentFolderId", "folderId"]))

        if kind == "folder":
            source_id = normalize_tidal_trn_id(
              first_tidal_value(entry, ["id", "uuid", "trn", "folderId"]),
              "folder",
            )
            if not source_id or source_id == "root":
                continue
            name = str(first_tidal_value(entry, ["name", "title"]) or "TIDAL Folder").strip() or "TIDAL Folder"
            folders.append({
              "sourceId": source_id,
              "name": name,
              "parentSourceId": parent_id,
              "position": index,
            })
            continue

        if kind == "playlist":
            source_id = normalize_tidal_trn_id(
              first_tidal_value(entry, ["uuid", "id", "trn", "playlistUuid", "playlistId"]),
              "playlist",
            )
            if source_id:
                playlist_folders[source_id] = {
                  "folderSourceId": parent_id,
                  "position": index,
                }

    return {"folders": folders, "playlistFolders": playlist_folders}


def fetch_tidal_playlist_folder_structure(session: tidalapi.Session) -> dict[str, Any]:
    try:
        flattened = parse_tidal_playlist_folder_entries(
          fetch_tidal_playlist_folder_flattened_items(session),
        )
        if flattened["folders"] or flattened["playlistFolders"]:
            return flattened
    except Exception as error:
        emit({
          "event": "tidal_playlist_folders_flattened_unavailable",
          "error": str(error).strip() or error.__class__.__name__,
        })

    folders: list[dict[str, Any]] = []
    playlist_folders: dict[str, dict[str, Any]] = {}
    seen_folders: set[str] = set()

    def walk(folder_id: str, parent_id: str | None, depth: int) -> None:
        if depth > 12 or folder_id in seen_folders:
            return
        seen_folders.add(folder_id)
        parsed = parse_tidal_playlist_folder_entries(
          fetch_tidal_playlist_folder_page_items(session, folder_id),
        )
        folders.extend({
          **folder,
          "parentSourceId": parent_id,
        } for folder in parsed["folders"])
        playlist_folders.update({
          source_id: {
            **assignment,
            "folderSourceId": parent_id,
          }
          for source_id, assignment in parsed["playlistFolders"].items()
        })
        for folder in parsed["folders"]:
            walk(folder["sourceId"], folder["sourceId"], depth + 1)

    try:
        walk("root", None, 0)
    except Exception as error:
        emit({
          "event": "tidal_playlist_folders_unavailable",
          "error": str(error).strip() or error.__class__.__name__,
        })

    return {"folders": folders, "playlistFolders": playlist_folders}


def safe_mix_image_url(mix: Any, size: int = 640) -> str | None:
    try:
        url = mix.image(size)
        if isinstance(url, str) and url.strip():
            return url
    except Exception:
        pass

    images = getattr(mix, "images", None)
    if images is None:
        return None
    if size >= 640 and getattr(images, "medium", None):
        return images.medium
    if getattr(images, "small", None):
        return images.small
    return getattr(images, "large", None)


def normalize_mix_type_value(value: Any) -> str | None:
    if value is None:
        return None
    if getattr(value, "value", None):
        return str(value.value)
    raw = str(value).strip()
    return raw or None


def serialize_home_mix(mix: Any) -> dict[str, Any]:
    mix_id = str(getattr(mix, "id", "") or "").strip()
    return {
      "id": f"tidal:mix:{mix_id}",
      "provider": "tidal",
      "sourceType": "mix",
      "sourceId": mix_id,
      "title": str(getattr(mix, "title", "") or "Mix").strip() or "Mix",
      "subtitle": (
          str(getattr(mix, "sub_title", "") or "").strip()
          or str(getattr(mix, "short_subtitle", "") or "").strip()
          or None
      ),
      "description": (
          str(getattr(mix, "short_subtitle", "") or "").strip()
          or str(getattr(mix, "sub_title", "") or "").strip()
          or None
      ),
      "artworkUrl": safe_mix_image_url(mix, 640),
      "providerUrl": f"https://tidal.com/browse/mix/{mix_id}" if mix_id else None,
      "trackCount": None,
      "mixType": normalize_mix_type_value(getattr(mix, "mix_type", None)),
    }


def serialize_home_playlist(playlist: Any) -> dict[str, Any]:
    artwork_url = None
    try:
        artwork_url = playlist.image(640)
    except Exception:
        artwork_url = resource_image_url(
            getattr(playlist, "square_picture", None) or getattr(playlist, "picture", None),
            640,
        )

    description = str(getattr(playlist, "description", "") or "").strip() or None
    return {
      "id": f"tidal:playlist:{getattr(playlist, 'id', '')}",
      "provider": "tidal",
      "sourceType": "playlist",
      "sourceId": str(getattr(playlist, "id", "") or "").strip(),
      "title": str(getattr(playlist, "name", "") or "Playlist").strip() or "Playlist",
      "subtitle": description,
      "description": description,
      "artworkUrl": artwork_url,
      "providerUrl": getattr(playlist, "share_url", None),
      "trackCount": getattr(playlist, "num_tracks", None),
    }


def serialize_home_track(track: Any) -> dict[str, Any]:
    album = getattr(track, "album", None)
    artist_name = get_track_artist_name(track) or "Unknown Artist"
    album_name = (
        getattr(album, "title", None)
        or getattr(album, "name", None)
        or "Unknown Album"
    )
    return {
      "id": f"tidal:track:{getattr(track, 'id', '')}",
      "provider": "tidal",
      "sourceId": str(getattr(track, "id", "") or "").strip(),
      "title": str(getattr(track, "title", "") or "Unknown Track").strip() or "Unknown Track",
      "artist": artist_name,
      "album": str(album_name).strip() or "Unknown Album",
      "duration": int(getattr(track, "duration", 0) or 0),
      "artworkUrl": safe_album_image_url(album) if album else None,
      "trackNumber": getattr(track, "track_num", None),
      "formatInfo": None,
    }


QUALITY_RANK: dict[str, int] = {
    "LOW": 0,
    "HIGH": 1,
    "LOSSLESS": 2,
    "MAX": 3,
}


TIDAL_V2_API_BASE_URL = os.environ.get("PUROS_TIDAL_V2_API_BASE_URL", "https://openapi.tidal.com/v2/")
TIDAL_V2_TRACK_MANIFEST_FORMATS = ["HEAACV1", "AACLC", "FLAC", "FLAC_HIRES"]
TIDAL_V2_TRACK_MANIFEST_PARAMS: dict[str, Any] = {
    "adaptive": "true",
    "formats": TIDAL_V2_TRACK_MANIFEST_FORMATS,
    "manifestType": "MPEG_DASH",
    "uriScheme": "DATA",
    "usage": "PLAYBACK",
}

TIDAL_FORMAT_TO_AUDIO_QUALITY: dict[str, str] = {
    "HEAACV1": "LOW",
    "AACLC": "HIGH",
    "FLAC": "LOSSLESS",
    "FLAC_HIRES": "HI_RES_LOSSLESS",
}

TIDAL_FORMAT_SELECTION_ORDER: dict[str, list[str]] = {
    "MAX": ["FLAC_HIRES", "FLAC", "AACLC", "HEAACV1"],
    "HI_RES": ["FLAC_HIRES", "FLAC", "AACLC", "HEAACV1"],
    "HI_RES_LOSSLESS": ["FLAC_HIRES", "FLAC", "AACLC", "HEAACV1"],
    "LOSSLESS": ["FLAC", "AACLC", "HEAACV1"],
    "HIGH": ["AACLC", "HEAACV1"],
    "LOW": ["HEAACV1", "AACLC"],
}


def serialize_search_track(track: Any) -> dict[str, Any]:
    album = getattr(track, "album", None)
    cover_url = None
    if album and getattr(album, "cover", None):
        cover_url = f"https://resources.tidal.com/images/{str(album.cover).replace('-', '/')}/640x640.jpg"

    quality_hint = infer_track_quality_hint(track)
    artist = getattr(track, "artist", None)
    return {
      "provider": "tidal",
      "id": str(getattr(track, "id")),
      "sourceId": str(getattr(track, "id")),
      "title": getattr(track, "title", "Unknown Track"),
      "artist": getattr(artist, "name", "Unknown Artist") if artist else "Unknown Artist",
      "album": getattr(album, "name", "Unknown Album") if album else "Unknown Album",
      "duration": getattr(track, "duration", 0),
      "coverUrl": cover_url,
      "quality": serialize_format_info(quality_hint),
      "providerUrl": getattr(track, "share_url", None),
    }


def serialize_catalog_artist(artist: Any) -> dict[str, Any]:
    payload = serialize_artist(artist)
    payload["sourceId"] = payload.get("sourceId") or payload.get("id")
    payload["normalizedName"] = str(payload.get("name", "")).lower().strip()
    payload["albumCount"] = getattr(artist, "num_albums", None)
    payload["trackCount"] = None
    payload["bio"] = getattr(artist, "bio", None)
    payload["bioSource"] = "tidal"
    payload["bioUrl"] = getattr(artist, "share_url", None)
    payload["genres"] = serialize_genres(artist)
    return payload


def serialize_catalog_album(album: Any) -> dict[str, Any]:
    payload = serialize_album(album)
    payload["sourceId"] = payload.get("sourceId") or payload.get("id")
    payload["normalizedTitle"] = str(payload.get("title", "")).lower().strip()
    payload["year"] = getattr(album, "year", None)
    payload["releaseType"] = normalize_release_type(getattr(album, "type", None))
    payload["releaseSection"] = infer_release_section(album, payload["releaseType"])
    payload["totalTracks"] = payload.pop("numberOfTracks", None)
    payload["totalDiscs"] = payload.pop("numberOfVolumes", None)
    artist = getattr(album, "artist", None)
    payload["primaryArtistSourceId"] = str(getattr(artist, "id")) if artist and getattr(artist, "id", None) is not None else None
    payload["primaryArtistName"] = getattr(artist, "name", None)
    payload["primaryArtistNormalizedName"] = str(getattr(artist, "name", "")).lower().strip() if artist else None
    payload["upc"] = getattr(album, "upc", None)
    payload["genres"] = serialize_genres(album)
    return payload


def normalize_release_type(value: Any) -> str | None:
    normalized = str(value or "").strip().upper()
    if normalized == "ALBUM":
        return "album"
    if normalized == "EP":
        return "ep"
    if normalized == "SINGLE":
        return "single"
    if normalized == "COMPILATION":
        return "compilation"
    return None


def infer_release_section(album: Any, release_type: str | None) -> str | None:
    if release_type == "compilation":
        return "compilation"
    if release_type == "ep":
        return "ep"
    if release_type == "single":
        return "single"

    haystack = " ".join([
        str(getattr(album, "name", "") or ""),
        str(getattr(album, "title", "") or ""),
        str(getattr(album, "version", "") or ""),
        " ".join(str(tag) for tag in (getattr(album, "media_metadata_tags", None) or [])),
    ]).lower()

    if "live" in haystack:
        return "live"
    if release_type == "album":
        return "album"
    return "other"


def serialize_catalog_playlist(playlist: Any) -> dict[str, Any]:
    raw_image = getattr(playlist, "square_picture", None) or getattr(playlist, "picture", None) or getattr(playlist, "image", None)
    return {
      "id": f"tidal:playlist:{getattr(playlist, 'id', '')}",
      "provider": "tidal",
      "sourceId": str(getattr(playlist, "id", "")),
      "title": getattr(playlist, "name", "Playlist"),
      "artworkUrl": resource_image_url(raw_image, 640),
      "trackCount": getattr(playlist, "num_tracks", None),
      "providerUrl": getattr(playlist, "share_url", None),
    }


def serialize_catalog_track(track: Any) -> dict[str, Any]:
    payload = serialize_track(track)
    payload["sourceId"] = payload.get("sourceId") or payload.get("id")
    payload["durationMs"] = int(payload.pop("duration", 0) * 1000)
    payload["normalizedTitle"] = str(payload.get("title", "")).lower().strip()
    payload["trackNumber"] = payload.pop("trackNumber", None)
    payload["discNumber"] = payload.pop("volumeNumber", None)
    album = getattr(track, "album", None)
    artist = getattr(track, "artist", None)
    payload["albumSourceId"] = str(getattr(album, "id")) if album and getattr(album, "id", None) is not None else None
    payload["albumTitle"] = (getattr(album, "title", None) or getattr(album, "name", None)) if album else None
    payload["primaryArtistSourceId"] = str(getattr(artist, "id")) if artist and getattr(artist, "id", None) is not None else None
    payload["primaryArtistName"] = getattr(artist, "name", None) if artist else None
    payload["primaryArtistNormalizedName"] = str(getattr(artist, "name", "")).lower().strip() if artist else None
    payload["isrc"] = getattr(track, "isrc", None)
    payload["upc"] = str(getattr(album, "upc", None)) if album and getattr(album, "upc", None) is not None else None
    payload["formatInfo"] = serialize_format_info(infer_track_quality_hint(track))
    payload["genres"] = serialize_genres(track)
    return payload


def serialize_format_info(quality: str | None) -> dict[str, Any]:
    if quality == "LOW":
        return {"format": "AAC", "sampleRate": 44100, "bitDepth": 16, "channels": 2, "bitrate": 96, "isLossless": False, "isHiRes": False, "isMqa": False, "isDsd": False}
    if quality == "LOSSLESS":
        return {"format": "FLAC", "sampleRate": 44100, "bitDepth": 16, "channels": 2, "bitrate": 1411, "isLossless": True, "isHiRes": False, "isMqa": False, "isDsd": False}
    if quality == "HI_RES" or quality == "MAX":
        return {"format": "FLAC_HIRES", "sampleRate": 96000, "bitDepth": 24, "channels": 2, "bitrate": 4608, "isLossless": True, "isHiRes": True, "isMqa": False, "isDsd": False}
    return {"format": "AAC", "sampleRate": 44100, "bitDepth": 16, "channels": 2, "bitrate": 320, "isLossless": False, "isHiRes": False, "isMqa": False, "isDsd": False}


def normalize_audio_quality(value: str | None) -> str | None:
    if value == "HI_RES_LOSSLESS" or value == "HI_RES":
        return "MAX"
    return value


def infer_track_quality_hint(track: Any) -> str | None:
    try:
        if bool(getattr(track, "is_hi_res_lossless", False)):
            return "MAX"
    except Exception:
        pass

    tags = getattr(track, "media_metadata_tags", None) or []
    normalized_tags = {str(tag).upper() for tag in tags}
    if "HIRES_LOSSLESS" in normalized_tags:
        return "MAX"
    if "LOSSLESS" in normalized_tags:
        return "LOSSLESS"

    try:
        if bool(getattr(track, "is_lossless", False)):
            return "LOSSLESS"
    except Exception:
        pass

    return normalize_audio_quality(getattr(track, "audio_quality", None))


def normalize_text(value: Any) -> str:
    raw = str(value or "").casefold()
    raw = unicodedata.normalize("NFD", raw)
    raw = "".join(ch for ch in raw if unicodedata.category(ch) != "Mn")
    return " ".join(raw.split())


HISTORY_MIX_TYPES = {
    "HISTORY_ALLTIME_MIX",
    "HISTORY_MONTHLY_MIX",
    "HISTORY_YEARLY_MIX",
}

PERSONALIZED_MIX_TYPES = {
    "WELCOME_MIX",
    "DAILY_MIX",
    "DISCOVERY_MIX",
    "NEW_RELEASE_MIX",
}


def is_mix_like(item: Any) -> bool:
    return bool(getattr(item, "id", None)) and (
        getattr(item, "mix_type", None) is not None
        or item.__class__.__name__ in ("Mix", "MixV2")
    )


def is_playlist_like(item: Any) -> bool:
    return bool(getattr(item, "id", None)) and bool(getattr(item, "name", None)) and hasattr(item, "tracks")


def classify_home_collection(payload: dict[str, Any], context_title: str | None = None) -> str | None:
    mix_type = str(payload.get("mixType") or "").strip().upper()
    normalized_title = normalize_text(payload.get("title"))
    normalized_subtitle = normalize_text(payload.get("subtitle"))
    normalized_context = normalize_text(context_title)

    if mix_type in HISTORY_MIX_TYPES:
        return "tidal:listening-highlights"
    if mix_type in PERSONALIZED_MIX_TYPES:
        return "tidal:personal-mixes"

    if normalized_title.startswith("my mix") or "daily discovery" in normalized_title:
        return "tidal:personal-mixes"
    if "most listened" in normalized_title or "most listened" in normalized_subtitle:
        return "tidal:listening-highlights"

    if payload.get("sourceType") == "mix":
        if "history" in normalized_context or "listening" in normalized_context:
            return "tidal:listening-highlights"
        if "mix" in normalized_context or "made for you" in normalized_context or "personal" in normalized_context:
            return "tidal:personal-mixes"

    return None


def upsert_home_collection(
    bucket: dict[str, list[dict[str, Any]]],
    seen: dict[str, set[str]],
    shelf_id: str,
    payload: dict[str, Any],
) -> None:
    source_id = str(payload.get("sourceId") or "").strip()
    if not source_id:
        return
    if source_id in seen[shelf_id]:
        return
    seen[shelf_id].add(source_id)
    bucket[shelf_id].append(payload)


def iter_page_category_items(page: Any) -> list[tuple[str | None, Any]]:
    pairs: list[tuple[str | None, Any]] = []
    for category in getattr(page, "categories", None) or []:
        context_title = getattr(category, "title", None)
        for item in (getattr(category, "items", None) or []):
            if item is not None:
                pairs.append((context_title, item))
    return pairs


def get_track_artist_name(track: Any) -> str:
    artist = getattr(track, "artist", None)
    if artist and getattr(artist, "name", None):
        return str(artist.name)
    artists = getattr(track, "artists", None) or []
    if artists:
        first = artists[0]
        if getattr(first, "name", None):
            return str(first.name)
    return ""


def get_track_album_name(track: Any) -> str:
    album = getattr(track, "album", None)
    if album and getattr(album, "name", None):
        return str(album.name)
    return ""


def get_track_album_track_count(track: Any) -> int:
    album = getattr(track, "album", None)
    if not album:
        return 0
    return int(getattr(album, "num_tracks", 0) or 0)


def dedupe_tracks_by_id(items: list[Any]) -> list[Any]:
    seen: set[str] = set()
    deduped: list[Any] = []
    for item in items:
        item_id = getattr(item, "id", None)
        if item_id is None:
            continue
        key = str(item_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def playback_quality_candidates(value: str | None) -> list[str]:
    normalized = (value or "MAX").upper()
    if normalized in ("MAX", "HI_RES", "HI_RES_LOSSLESS"):
        return ["MAX", "LOSSLESS", "HIGH", "LOW"]
    if normalized == "LOSSLESS":
        return ["LOSSLESS", "HIGH", "LOW"]
    if normalized == "LOW":
        return ["LOW"]
    return ["HIGH", "LOW"]


def build_track_manifest_v2_params() -> dict[str, Any]:
    return {
        "adaptive": TIDAL_V2_TRACK_MANIFEST_PARAMS["adaptive"],
        "formats": list(TIDAL_V2_TRACK_MANIFEST_FORMATS),
        "manifestType": TIDAL_V2_TRACK_MANIFEST_PARAMS["manifestType"],
        "uriScheme": TIDAL_V2_TRACK_MANIFEST_PARAMS["uriScheme"],
        "usage": TIDAL_V2_TRACK_MANIFEST_PARAMS["usage"],
    }


def v2_auth_headers(session: tidalapi.Session) -> dict[str, str]:
    token_type = getattr(session, "token_type", None) or "Bearer"
    token = getattr(session, "access_token", None)
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"{token_type} {token}"
    client = getattr(session, "request", None)
    client_version = getattr(client, "client_version", None)
    user_agent = getattr(client, "user_agent", None)
    if client_version:
        headers["x-tidal-client-version"] = str(client_version)
    if user_agent:
        headers["User-Agent"] = str(user_agent)
    return headers


def request_track_manifest_v2_response(session: tidalapi.Session, track_id: str) -> requests.Response:
    path = f"trackManifests/{track_id}"
    params = build_track_manifest_v2_params()
    headers = v2_auth_headers(session)
    emit({
        "event": "tidal_v2_track_manifest_request",
        "endpoint": f"{TIDAL_V2_API_BASE_URL.rstrip('/')}/{path}",
        "trackId": track_id,
        "params": params,
    })

    client = getattr(session, "request", None)
    if client is not None and hasattr(client, "basic_request"):
        response = client.basic_request("GET", path, params=params, headers=headers, base_url=TIDAL_V2_API_BASE_URL)
        if response.status_code in (401, 403) and getattr(session, "refresh_token", None):
            try:
                if session.token_refresh(session.refresh_token):
                    response = client.basic_request(
                        "GET",
                        path,
                        params=params,
                        headers=v2_auth_headers(session),
                        base_url=TIDAL_V2_API_BASE_URL,
                    )
            except Exception:
                pass
        response.raise_for_status()
        return response

    response = requests.get(
        f"{TIDAL_V2_API_BASE_URL.rstrip('/')}/{path}",
        params=params,
        headers=headers,
        timeout=30,
    )
    response.raise_for_status()
    return response


def unwrap_track_manifest_v2_payload(payload: dict[str, Any]) -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    if isinstance(payload, dict):
        candidates.append(payload)
        data = payload.get("data")
        if isinstance(data, dict):
            candidates.append(data)
            nested = data.get("data")
            if isinstance(nested, dict):
                candidates.append(nested)
                attributes = nested.get("attributes")
                if isinstance(attributes, dict):
                    candidates.append(attributes)
            attributes = data.get("attributes")
            if isinstance(attributes, dict):
                candidates.append(attributes)
        attributes = payload.get("attributes")
        if isinstance(attributes, dict):
            candidates.append(attributes)

    merged: dict[str, Any] = {}
    for candidate in candidates:
        for key, value in candidate.items():
            if key not in merged and value is not None:
                merged[key] = value
    return merged


def normalize_available_formats(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    known = {item.upper(): item.upper() for item in TIDAL_V2_TRACK_MANIFEST_FORMATS}
    formats: list[str] = []
    for item in value:
        normalized = str(item or "").strip().upper()
        if normalized in known and normalized not in formats:
            formats.append(normalized)
    return formats


def select_tidal_v2_format(requested_quality: str, available_formats: list[str]) -> str:
    available = set(available_formats)
    for candidate in TIDAL_FORMAT_SELECTION_ORDER.get(requested_quality.upper(), TIDAL_FORMAT_SELECTION_ORDER["HIGH"]):
        if candidate in available:
            return candidate
    for candidate in ("AACLC", "HEAACV1", "FLAC", "FLAC_HIRES"):
        if candidate in available:
            return candidate
    raise RuntimeError(f"TIDAL v2 returned no supported audio formats: {available_formats}")


def normalize_mpd_xml_for_tidalapi(mpd_xml: str) -> str:
    stripped = str(mpd_xml or "").strip()
    if stripped.startswith("<?xml"):
        stripped = stripped.split("?>", 1)[1].lstrip()
    return "<?xml version='1.0' encoding='UTF-8'?>" + stripped


def decode_mpd_manifest_data(data: str) -> str:
    raw = str(data or "").strip()
    if raw.startswith("data:"):
        metadata, separator, payload = raw.partition(",")
        if not separator:
            raise RuntimeError("TIDAL v2 returned an invalid data URI manifest")
        if ";base64" in metadata.lower():
            raw = payload
        else:
            return payload
    if raw.startswith("<"):
        return raw
    try:
        return base64.b64decode(raw).decode("utf-8")
    except Exception as error:
        raise RuntimeError("TIDAL v2 returned an invalid DASH manifest") from error


def encode_mpd_manifest_data(mpd_xml: str) -> str:
    return base64.b64encode(normalize_mpd_xml_for_tidalapi(mpd_xml).encode("utf-8")).decode("ascii")


def xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def representation_label(representation: ET.Element) -> str | None:
    for child in list(representation):
        if xml_local_name(child.tag) == "Label" and child.text:
            return child.text.strip().upper()
    return None


def representation_format(representation: ET.Element) -> str | None:
    label = representation_label(representation)
    if label in ("FLAC_HIRES", "FLAC", "AACLC", "HEAACV1"):
        return label

    representation_id = str(representation.attrib.get("id") or "").strip().upper()
    for prefix in ("FLAC_HIRES", "FLAC", "AACLC", "HEAACV1"):
        if representation_id.startswith(prefix):
            return prefix

    codecs = str(representation.attrib.get("codecs") or "").casefold()
    if "flac" in codecs:
        return "FLAC"
    if "mp4a.40.5" in codecs:
        return "HEAACV1"
    if "mp4a.40.2" in codecs or "mp4a" in codecs:
        return "AACLC"
    return None


def prune_mpd_to_selected_format(mpd_xml: str, selected_format: str) -> str:
    normalized = normalize_mpd_xml_for_tidalapi(mpd_xml)
    try:
        root = ET.fromstring(normalized.split("?>", 1)[1])
    except Exception:
        return normalized

    parent_by_child = {child: parent for parent in root.iter() for child in list(parent)}
    selected_representations = [
        element
        for element in root.iter()
        if xml_local_name(element.tag) == "Representation"
        and representation_format(element) == selected_format
    ]
    if not selected_representations:
        return normalized

    selected = selected_representations[0]
    for element in [
        element for element in root.iter()
        if xml_local_name(element.tag) == "Representation" and element is not selected
    ]:
        parent = parent_by_child.get(element)
        if parent is not None:
            parent.remove(element)

    ET.register_namespace("", "urn:mpeg:dash:schema:mpd:2011")
    ET.register_namespace("xsi", "http://www.w3.org/2001/XMLSchema-instance")
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
    ET.register_namespace("cenc", "urn:mpeg:cenc:2013")
    pruned = ET.tostring(root, encoding="unicode")
    return normalize_mpd_xml_for_tidalapi(pruned)


def mpd_selected_audio_details(mpd_xml: str, selected_format: str) -> dict[str, int]:
    details = {
        "sampleRate": 44100,
        "bitDepth": 24 if selected_format == "FLAC_HIRES" else 16,
    }
    normalized = normalize_mpd_xml_for_tidalapi(mpd_xml)
    try:
        root = ET.fromstring(normalized.split("?>", 1)[1])
    except Exception:
        return details

    for representation in root.iter():
        if xml_local_name(representation.tag) != "Representation":
            continue
        if representation_format(representation) != selected_format:
            continue

        representation_id = str(representation.attrib.get("id") or "")
        id_parts = [part.strip() for part in representation_id.split(",")]
        sample_rate = representation.attrib.get("audioSamplingRate") or representation.attrib.get("sampleRate")
        bit_depth = representation.attrib.get("audioBitsPerSample") or representation.attrib.get("bitDepth")
        if not sample_rate and len(id_parts) >= 2:
            sample_rate = id_parts[1]
        if not bit_depth and len(id_parts) >= 3:
            bit_depth = id_parts[2]

        try:
            if sample_rate:
                details["sampleRate"] = int(str(sample_rate))
        except ValueError:
            pass
        try:
            if bit_depth:
                details["bitDepth"] = int(str(bit_depth))
        except ValueError:
            pass
        return details

    return details


def fetch_manifest_uri_data(uri: str) -> tuple[str | None, str | None]:
    if uri.startswith("data:"):
        metadata = uri.split(",", 1)[0]
        mime_type = metadata[5:].split(";", 1)[0].strip()
        return mime_type or "application/dash+xml", uri

    response = requests.get(uri, timeout=30)
    response.raise_for_status()
    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip()
    if "xml" in content_type or uri.split("?", 1)[0].lower().endswith(".mpd"):
        return "application/dash+xml", encode_mpd_manifest_data(response.text)
    return content_type or None, uri


def extract_manifest_payload(attributes: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    manifest = attributes.get("manifest")
    if isinstance(manifest, dict):
        mime_type = (
            manifest.get("mimeType")
            or manifest.get("mime_type")
            or attributes.get("manifestMimeType")
            or attributes.get("manifest_mime_type")
        )
        data = manifest.get("data") or manifest.get("manifest")
        uri = manifest.get("uri") or manifest.get("url")
        return str(mime_type) if mime_type else None, str(data) if data else None, str(uri) if uri else None

    mime_type = attributes.get("manifestMimeType") or attributes.get("manifest_mime_type")
    if isinstance(manifest, str) and manifest.strip():
        return str(mime_type) if mime_type else "application/dash+xml", manifest, None

    uri = attributes.get("uri") or attributes.get("url")
    return str(mime_type) if mime_type else None, None, str(uri) if uri else None


class DirectStreamManifest:
    def __init__(self, url: str, selected_format: str):
        self.urls = [url]
        self.manifest = None
        self.manifest_mime_type = None
        self.manifest_parsed = None
        self.codecs = "FLAC" if selected_format.startswith("FLAC") else "MP4A"
        self.encryption_type = "NONE"
        self.encryption_key = None
        self.sample_rate = 44100
        self.mime_type = "audio/flac" if selected_format.startswith("FLAC") else "audio/mp4"
        self.file_extension = ".flac" if selected_format.startswith("FLAC") else ".m4a"
        self.dash_info = None

    def get_urls(self) -> list[str]:
        return self.urls

    @property
    def is_encrypted(self) -> bool:
        return False

    @property
    def is_mpd(self) -> bool:
        return False

    @property
    def is_bts(self) -> bool:
        return False


def make_tidal_v2_stream(
    track_id: str,
    selected_format: str,
    attributes: dict[str, Any],
    manifest_mime_type: str,
    manifest_data: str,
) -> Any:
    decoded_mpd_xml = decode_mpd_manifest_data(manifest_data)
    audio_details = mpd_selected_audio_details(decoded_mpd_xml, selected_format)
    mpd_xml = prune_mpd_to_selected_format(decoded_mpd_xml, selected_format)
    audio_quality = TIDAL_FORMAT_TO_AUDIO_QUALITY[selected_format]
    track_norm = attributes.get("trackAudioNormalizationData") if isinstance(attributes.get("trackAudioNormalizationData"), dict) else {}
    album_norm = attributes.get("albumAudioNormalizationData") if isinstance(attributes.get("albumAudioNormalizationData"), dict) else {}
    json_obj = {
        "trackId": track_id,
        "audioMode": "STEREO",
        "audioQuality": audio_quality,
        "manifestMimeType": manifest_mime_type or "application/dash+xml",
        "manifestHash": attributes.get("hash") or "",
        "manifest": encode_mpd_manifest_data(mpd_xml),
        "assetPresentation": attributes.get("trackPresentation") or "FULL",
        "albumReplayGain": album_norm.get("replayGain", 1.0),
        "albumPeakAmplitude": album_norm.get("peakAmplitude", 1.0),
        "trackReplayGain": track_norm.get("replayGain", 1.0),
        "trackPeakAmplitude": track_norm.get("peakAmplitude", 1.0),
        "bitDepth": audio_details["bitDepth"],
        "sampleRate": audio_details["sampleRate"],
    }
    return tidalapi.media.Stream().parse(json_obj)


def is_rate_limit_error(error: Exception) -> bool:
    if isinstance(error, TooManyRequests):
        return True
    message = str(error).casefold()
    return "too many requests" in message or "429" in message


def is_transient_tidal_error(error: Exception) -> bool:
    if is_rate_limit_error(error):
        return True
    message = str(error).casefold()
    return any(token in message for token in (
        "500",
        "502",
        "503",
        "504",
        "internal server error",
        "bad gateway",
        "service unavailable",
        "gateway timeout",
        "connection reset",
        "timed out",
        "timeout",
    ))


def retry_tidal_call(label: str, fn: Callable[[], Any], *, attempts: int = 4) -> Any:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return fn()
        except Exception as error:
            last_error = error
            if not is_transient_tidal_error(error) or attempt >= attempts - 1:
                raise
            delay = 0.75 * (attempt + 1)
            emit({
                "event": "transient_retry",
                "label": label,
                "attempt": attempt + 1,
                "delaySeconds": delay,
                "error": str(error).strip() or error.__class__.__name__,
            })
            time.sleep(delay)

    assert last_error is not None
    raise last_error


def request_stream_payload(track: Any, requested_quality: str) -> tuple[Any, Any, dict[str, Any], str]:
    track_session = getattr(track, "session", None)
    if track_session is None:
        raise RuntimeError("TIDAL track is missing its authenticated session")

    track_id = str(getattr(track, "id", "") or "").strip()
    if not track_id:
        raise RuntimeError("Missing TIDAL track id for stream resolution")

    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = request_track_manifest_v2_response(track_session, track_id)
            response_payload = response.json()
            attributes = unwrap_track_manifest_v2_payload(response_payload)
            available_formats = normalize_available_formats(attributes.get("formats"))
            selected_format = select_tidal_v2_format(requested_quality, available_formats)
            emit({
                "event": "tidal_v2_selected_format",
                "trackId": track_id,
                "requestedQuality": requested_quality,
                "selectedFormat": selected_format,
                "availableFormats": available_formats,
            })

            manifest_mime_type, manifest_data, manifest_uri = extract_manifest_payload(attributes)
            if manifest_uri and not manifest_data:
                manifest_mime_type, fetched_data = fetch_manifest_uri_data(manifest_uri)
                if fetched_data and fetched_data.startswith(("http://", "https://")):
                    stream = tidalapi.media.Stream().parse({
                        "trackId": track_id,
                        "audioMode": "STEREO",
                        "audioQuality": TIDAL_FORMAT_TO_AUDIO_QUALITY[selected_format],
                        "manifestMimeType": manifest_mime_type or "",
                        "manifestHash": attributes.get("hash") or "",
                        "manifest": "",
                        "bitDepth": 24 if selected_format == "FLAC_HIRES" else 16,
                        "sampleRate": 44100,
                    })
                    return (
                        stream,
                        DirectStreamManifest(fetched_data, selected_format),
                        {"formats": available_formats, "selectedFormat": selected_format},
                        track_id,
                    )
                manifest_data = fetched_data

            if not manifest_data:
                raise RuntimeError("TIDAL v2 trackManifests response did not include a manifest")

            if manifest_mime_type and "dash" not in manifest_mime_type.lower() and not str(manifest_data).strip().startswith(("<", "PD94")):
                stream = tidalapi.media.Stream().parse({
                    "trackId": track_id,
                    "audioMode": "STEREO",
                    "audioQuality": TIDAL_FORMAT_TO_AUDIO_QUALITY[selected_format],
                    "manifestMimeType": manifest_mime_type,
                    "manifestHash": attributes.get("hash") or "",
                    "manifest": "",
                    "bitDepth": 24 if selected_format == "FLAC_HIRES" else 16,
                    "sampleRate": 44100,
                })
                return (
                    stream,
                    DirectStreamManifest(str(manifest_data), selected_format),
                    {"formats": available_formats, "selectedFormat": selected_format},
                    track_id,
                )

            stream = make_tidal_v2_stream(
                track_id,
                selected_format,
                attributes,
                manifest_mime_type or "application/dash+xml",
                manifest_data,
            )
            stream_manifest = stream.get_stream_manifest()
            return (
                stream,
                stream_manifest,
                {"formats": available_formats, "selectedFormat": selected_format},
                track_id,
            )
        except Exception as error:
            last_error = error
            if not is_rate_limit_error(error) or attempt >= 2:
                raise
            time.sleep(0.5 * (attempt + 1))

    assert last_error is not None
    raise last_error


def score_recovery_track_candidate(candidate: Any, reference: Any) -> tuple[int, int, int, int, int, int]:
    candidate_title = normalize_text(getattr(candidate, "title", None))
    reference_title = normalize_text(getattr(reference, "title", None))
    candidate_artist = normalize_text(get_track_artist_name(candidate))
    reference_artist = normalize_text(get_track_artist_name(reference))
    candidate_album = normalize_text(get_track_album_name(candidate))
    reference_album = normalize_text(get_track_album_name(reference))

    candidate_track_num = int(getattr(candidate, "track_num", 0) or 0)
    reference_track_num = int(getattr(reference, "track_num", 0) or 0)
    candidate_duration = int(getattr(candidate, "duration", 0) or 0)
    reference_duration = int(getattr(reference, "duration", 0) or 0)
    candidate_album_track_count = get_track_album_track_count(candidate)
    reference_album_track_count = get_track_album_track_count(reference)

    title_score = 6 if candidate_title == reference_title else 0
    artist_score = 6 if candidate_artist == reference_artist else 0
    album_score = 6 if candidate_album and candidate_album == reference_album else 0
    track_number_score = 4 if candidate_track_num > 0 and candidate_track_num == reference_track_num else 0
    album_shape_score = 0
    if reference_album_track_count > 0:
        if candidate_album_track_count == reference_album_track_count:
            album_shape_score = 6
        elif reference_album_track_count > 1 and candidate_album_track_count == 1:
            album_shape_score = -8
        elif reference_album_track_count > 1 and candidate_album_track_count > 1:
            album_shape_score = 1
    release_context_penalty = 0
    candidate_context = " ".join([
        str(getattr(candidate, "title", None) or ""),
        str(get_track_album_name(candidate) or ""),
        str(getattr(getattr(candidate, "album", None), "version", None) or ""),
    ]).casefold()
    reference_context = " ".join([
        str(getattr(reference, "title", None) or ""),
        str(get_track_album_name(reference) or ""),
        str(getattr(getattr(reference, "album", None), "version", None) or ""),
    ]).casefold()
    if candidate_album and reference_album and candidate_album != reference_album:
        release_context_penalty -= 6
    if " live" in f" {candidate_context}" and " live" not in f" {reference_context}":
        release_context_penalty -= 10
    if "wireless" in candidate_context and "wireless" not in reference_context:
        release_context_penalty -= 8
    duration_penalty = abs(candidate_duration - reference_duration)
    availability_score = (
        (2 if bool(getattr(candidate, "stream_ready", False)) else 0) +
        (1 if bool(getattr(candidate, "available", False) or getattr(candidate, "allow_streaming", False)) else 0)
    )
    quality_score = QUALITY_RANK.get(infer_track_quality_hint(candidate) or "", -1)
    return (
        title_score + artist_score + album_score + track_number_score + album_shape_score + release_context_penalty,
        availability_score,
        -duration_penalty,
        quality_score,
        int(getattr(candidate, "sample_rate", 0) or 0) + int(getattr(candidate, "bit_depth", 0) or 0),
        int(getattr(candidate, "id", 0) or 0),
    )


def fetch_album_recovery_candidates(session: tidalapi.Session, reference: Any) -> list[Any]:
    artist_name = get_track_artist_name(reference)
    album_name = get_track_album_name(reference)
    if not album_name:
        return []

    album_queries = [
        " ".join(part for part in [artist_name, album_name] if part),
        album_name,
    ]

    candidate_albums: list[Any] = []
    for query in album_queries:
        if not query.strip():
            continue
        try:
            search_results = session.search(query, models=[tidalapi.album.Album], limit=12)
            candidate_albums.extend(search_results.get("albums", []))
        except Exception:
            continue

    normalized_album = normalize_text(album_name)
    normalized_artist = normalize_text(artist_name)
    deduped_albums = dedupe_by_id(candidate_albums)
    filtered_albums = [
        album for album in deduped_albums
        if normalize_text(getattr(album, "name", None) or getattr(album, "title", None)) == normalized_album
        and normalize_text(getattr(getattr(album, "artist", None), "name", None)) == normalized_artist
    ]
    reference_album_track_count = get_track_album_track_count(reference)
    filtered_albums.sort(
        key=lambda album: (
            1 if int(getattr(album, "num_tracks", 0) or 0) == reference_album_track_count and reference_album_track_count > 0 else 0,
            1 if int(getattr(album, "num_tracks", 0) or 0) > 1 else 0,
            int(getattr(album, "num_tracks", 0) or 0),
            int(getattr(album, "year", 0) or 0),
        ),
        reverse=True,
    )

    matches: list[Any] = []
    for album in filtered_albums:
        try:
            album_tracks = fetch_album_tracks(session.album(str(getattr(album, "id"))))
        except Exception:
            continue

        matches.extend([
            item for item in album_tracks
            if normalize_text(getattr(item, "title", None)) == normalize_text(getattr(reference, "title", None))
            and (
                int(getattr(item, "track_num", 0) or 0) == int(getattr(reference, "track_num", 0) or 0)
                or int(getattr(reference, "track_num", 0) or 0) == 0
            )
        ])

    return dedupe_tracks_by_id(matches)


def fetch_playback_recovery_candidates(session: tidalapi.Session, track: Any) -> list[Any]:
    candidates: list[Any] = [track]
    album = getattr(track, "album", None)
    reference_title = normalize_text(getattr(track, "title", None))
    reference_artist = normalize_text(get_track_artist_name(track))
    reference_album = normalize_text(get_track_album_name(track))

    if album is not None:
        try:
            album_tracks = fetch_album_tracks(session.album(str(getattr(album, "id"))))
            candidates.extend(
                item for item in album_tracks
                if normalize_text(getattr(item, "title", None)) == reference_title
            )
        except Exception:
            pass

    candidates.extend(fetch_album_recovery_candidates(session, track))

    search_queries = [
        " ".join(part for part in [get_track_artist_name(track), getattr(track, "title", None), reference_album] if part),
        " ".join(part for part in [get_track_artist_name(track), getattr(track, "title", None)] if part),
    ]

    for query in search_queries:
        if not query.strip():
            continue
        try:
            search_results = session.search(query, models=[tidalapi.media.Track], limit=25)
            tracks = search_results.get("tracks", [])
        except Exception:
            continue

        exact_matches = [
            item for item in tracks
            if normalize_text(getattr(item, "title", None)) == reference_title
            and normalize_text(get_track_artist_name(item)) == reference_artist
        ]
        if reference_album:
            album_matches = [
                item for item in exact_matches
                if normalize_text(get_track_album_name(item)) == reference_album
            ]
            if album_matches:
                exact_matches = album_matches
        candidates.extend(exact_matches)

    unique_candidates = dedupe_tracks_by_id(candidates)
    if len(unique_candidates) <= 1:
        return unique_candidates

    head = unique_candidates[0]
    tail = sorted(
        unique_candidates[1:],
        key=lambda item: score_recovery_track_candidate(item, track),
        reverse=True,
    )
    return [head, *tail]


def ensure_output_dir(path_value: str | None) -> pathlib.Path:
    target = pathlib.Path(path_value or pathlib.Path(os.getcwd()) / "tmp" / "tidal-playback")
    target.mkdir(parents=True, exist_ok=True)
    return target


def dedupe_by_id(items: list[Any]) -> list[Any]:
    seen: set[str] = set()
    deduped: list[Any] = []
    for item in items:
        item_id = getattr(item, "id", None)
        if item_id is None:
            continue
        key = str(item_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def dedupe_catalog_playlists(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for item in items:
        item_id = str(item.get("sourceId") or "").strip()
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        deduped.append(item)
    return deduped


def page_category_title(category: Any) -> str:
    return str(getattr(category, "title", "") or "").strip().lower()


def fetch_page_category_items(category: Any, limit: int) -> list[Any]:
    items = list(getattr(category, "items", None) or [])
    if len(items) >= limit:
        return items[:limit]
    try:
        more_page = category.show_more() if hasattr(category, "show_more") else None
        if more_page and getattr(more_page, "categories", None):
            for more_category in more_page.categories:
                items.extend(list(getattr(more_category, "items", None) or []))
    except Exception:
        pass
    return items[:limit]


def fetch_artist_page_sections(artist: Any, limit: int) -> tuple[dict[str, str], list[Any], list[Any]]:
    album_sections: dict[str, str] = {}
    playlists: list[Any] = []
    albums: list[Any] = []

    try:
        page = artist.page()
    except Exception:
        return album_sections, playlists, albums

    for category in getattr(page, "categories", None) or []:
        title = page_category_title(category)
        items = fetch_page_category_items(category, limit)
        if not items:
            continue

        if "playlist" in title:
            playlists.extend([item for item in items if getattr(item, "id", None) is not None])
            continue

        if "live" in title:
            section = "live"
        elif "compilation" in title:
            section = "compilation"
        elif "other" in title:
            section = "other"
        elif "ep" in title and "single" in title:
            section = "ep_single"
        elif title.startswith("album") or title == "albums":
            section = "album"
        else:
            continue

        for item in items:
            item_id = getattr(item, "id", None)
            if item_id is None:
                continue
            albums.append(item)
            album_sections[str(item_id)] = section

    return album_sections, dedupe_by_id(playlists), dedupe_by_id(albums)


def fetch_artist_discography(artist: Any, limit: int) -> list[Any]:
    page_size = min(max(limit, 50), 100)
    albums = fetch_all(artist.get_albums, limit=page_size)
    eps_and_singles = fetch_all(artist.get_ep_singles, limit=page_size)
    other = fetch_all(artist.get_other, limit=page_size) if hasattr(artist, "get_other") else []
    return dedupe_by_id([*albums, *eps_and_singles, *other])


def fetch_album_tracks(album: Any) -> list[Any]:
    tracks = fetch_all(album.tracks, limit=100)
    declared_total = int(getattr(album, "num_tracks", 0) or 0)
    if declared_total <= 0 or len(tracks) >= declared_total or not hasattr(album, "items"):
        return tracks

    media_items = fetch_all(album.items, limit=100)
    fallback_tracks = [
        item for item in media_items
        if isinstance(item, tidalapi.media.Track)
    ]
    if len(fallback_tracks) > len(tracks):
        return fallback_tracks
    return tracks


def merge_stream_urls_to_file(
    urls: list[str],
    destination: pathlib.Path,
    on_progress: Callable[[float], None] | None = None,
) -> None:
    total_segments = max(len(urls), 1)
    downloaded_segments = 0
    with requests.Session() as session:
        for url in urls:
            with session.get(url, stream=True, timeout=30) as response:
                response.raise_for_status()
                total_bytes = int(response.headers.get("content-length") or 0)
                downloaded_bytes = 0
                with destination.open("ab") as out_file:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            out_file.write(chunk)
                            downloaded_bytes += len(chunk)
                            if on_progress is not None and total_bytes > 0:
                                segment_progress = min(downloaded_bytes / total_bytes, 1.0)
                                overall = min((downloaded_segments + segment_progress) / total_segments, 1.0)
                                on_progress(overall)
            downloaded_segments += 1
            if on_progress is not None:
                on_progress(min(downloaded_segments / total_segments, 1.0))


def maybe_decrypt_file(source: pathlib.Path, stream_manifest: Any) -> pathlib.Path:
    if not getattr(stream_manifest, "is_encrypted", False):
        return source

    decrypted_path = source.with_suffix(source.suffix + ".decrypted")
    key, nonce = decrypt_security_token(stream_manifest.encryption_key)
    decrypt_file(source, decrypted_path, key, nonce)
    return decrypted_path


def infer_lossless_from_codec(codecs: str) -> bool:
    normalized = (codecs or "").upper()
    return normalized in ("FLAC", "ALAC") or "FLAC" in normalized or "ALAC" in normalized


def infer_actual_quality(stream: Any, stream_manifest: Any, requested_quality: str) -> str:
    sample_rate = int(getattr(stream_manifest, "sample_rate", 0) or getattr(stream, "sample_rate", 0) or 0)
    bit_depth = int(getattr(stream, "bit_depth", 0) or 0)
    codecs = str(getattr(stream_manifest, "codecs", "") or "").upper()

    if infer_lossless_from_codec(codecs):
        if bit_depth > 16 or sample_rate > 48000:
            return "MAX"
        return "LOSSLESS"

    resolved = normalize_audio_quality(getattr(stream, "audio_quality", None))
    if resolved in QUALITY_RANK:
        return resolved

    if requested_quality == "LOW":
        return "LOW"
    return "HIGH"


def describe_stream_format(stream: Any, stream_manifest: Any, resolved_quality: str) -> dict[str, Any]:
    codecs = str(getattr(stream_manifest, "codecs", "") or "").upper()
    sample_rate = int(getattr(stream_manifest, "sample_rate", 0) or getattr(stream, "sample_rate", 0) or 44100)
    bit_depth = int(getattr(stream, "bit_depth", 0) or 0)
    if bit_depth <= 0:
        bit_depth = 24 if resolved_quality == "MAX" and infer_lossless_from_codec(codecs) else 16

    if codecs in ("FLAC", "ALAC"):
        format_name = "FLAC_HIRES" if bit_depth > 16 or sample_rate > 48000 else "FLAC"
        bitrate = None
        is_lossless = True
    else:
        format_name = "AAC"
        bitrate = 96 if resolved_quality == "LOW" else 320
        is_lossless = False

    return {
        "format": format_name,
        "sampleRate": sample_rate,
        "bitDepth": bit_depth,
        "channels": 2,
        "bitrate": bitrate,
        "isLossless": is_lossless,
        "isHiRes": bit_depth > 16 or sample_rate > 48000,
        "isMqa": False,
        "isDsd": False,
    }


def select_best_stream(track: Any, preferred_quality: str | None) -> tuple[Any, Any, str, str]:
    best_stream = None
    best_manifest = None
    best_quality = None
    best_actual_track_id = None
    best_score: tuple[int, int, int, int] | None = None
    last_error: Exception | None = None
    attempt_errors: list[str] = []

    for requested_quality in playback_quality_candidates(preferred_quality):
        try:
            media_stream, stream_manifest, playback_payload, actual_track_id = request_stream_payload(track, requested_quality)
            resolved_quality = infer_actual_quality(media_stream, stream_manifest, requested_quality)
            score = (
                QUALITY_RANK.get(resolved_quality, -1),
                int(getattr(stream_manifest, "sample_rate", 0) or getattr(media_stream, "sample_rate", 0) or 0),
                int(getattr(media_stream, "bit_depth", 0) or 0),
                int(playback_payload.get("bitrate", 0) or 0),
            )
            if best_score is None or score > best_score:
                best_stream = media_stream
                best_manifest = stream_manifest
                best_quality = resolved_quality
                best_actual_track_id = actual_track_id
                best_score = score
        except Exception as error:  # noqa: BLE001 - helper should gracefully try lower qualities
            last_error = error
            attempt_errors.append(f"{requested_quality}:{str(error).strip() or error.__class__.__name__}")
            if is_rate_limit_error(error):
                raise

    if best_stream is None or best_manifest is None or best_quality is None or best_actual_track_id is None:
        if last_error is not None:
            detail = " | ".join(attempt_errors[:8])
            raise RuntimeError(f"{str(last_error).strip() or last_error.__class__.__name__} | attempts={detail}")
        raise RuntimeError("Could not resolve a playable TIDAL stream URL")

    return best_stream, best_manifest, best_quality, best_actual_track_id


def select_first_playable_stream(track: Any, preferred_quality: str | None) -> tuple[Any, Any, str, str]:
    last_error: Exception | None = None
    attempt_errors: list[str] = []

    for requested_quality in playback_quality_candidates(preferred_quality):
        try:
            media_stream, stream_manifest, _playback_payload, actual_track_id = request_stream_payload(
                track,
                requested_quality,
            )
            resolved_quality = infer_actual_quality(media_stream, stream_manifest, requested_quality)
            return media_stream, stream_manifest, resolved_quality, actual_track_id
        except Exception as error:  # noqa: BLE001 - lower qualities remain valid fallbacks
            last_error = error
            attempt_errors.append(f"{requested_quality}:{str(error).strip() or error.__class__.__name__}")
            if is_rate_limit_error(error):
                raise

    if last_error is not None:
        detail = " | ".join(attempt_errors[:8])
        raise RuntimeError(f"{str(last_error).strip() or last_error.__class__.__name__} | attempts={detail}")
    raise RuntimeError("Could not resolve a playable TIDAL stream URL")


def format_recovery_trace_entry(
    candidate: Any,
    resolved_quality: str,
    media_stream: Any,
    stream_manifest: Any,
    reference: Any,
) -> str:
    album_name = get_track_album_name(candidate) or "Unknown Album"
    album_track_count = get_track_album_track_count(candidate)
    sample_rate = int(getattr(stream_manifest, "sample_rate", 0) or getattr(media_stream, "sample_rate", 0) or 0)
    bit_depth = int(getattr(media_stream, "bit_depth", 0) or 0)
    recovery_score = score_recovery_track_candidate(candidate, reference)
    return (
        f"{getattr(candidate, 'id', 'unknown')}"
        f"[{resolved_quality}/{bit_depth or 0}/{sample_rate or 0}]"
        f" album={album_name}"
        f" tracks={album_track_count}"
        f" match={recovery_score[0]}"
        f" availability={recovery_score[1]}"
        f" duration={recovery_score[2]}"
    )


def resolve_best_playable_track(
    session: tidalapi.Session,
    track_id: str,
    preferred_quality: str | None,
    *,
    allow_recovery: bool = True,
) -> tuple[Any, Any, Any, str, list[str]]:
    reference_track = session.track(track_id, with_album=True)
    last_error: Exception | None = None
    successful_candidates: list[tuple[tuple[int, int, int, int, int, int, int, int, int, int], Any, Any, Any, str, str]] = []
    recovery_trace: list[str] = []

    candidates = fetch_playback_recovery_candidates(session, reference_track) if allow_recovery else [reference_track]

    for candidate in candidates:
        try:
            media_stream, stream_manifest, resolved_quality, actual_track_id = select_best_stream(candidate, preferred_quality)
            recovery_score = score_recovery_track_candidate(candidate, reference_track)
            sample_rate = int(getattr(stream_manifest, "sample_rate", 0) or getattr(media_stream, "sample_rate", 0) or 0)
            bit_depth = int(getattr(media_stream, "bit_depth", 0) or 0)
            bitrate = int(getattr(media_stream, "bitrate", 0) or getattr(stream_manifest, "bitrate", 0) or 0)
            stream_score = (
                recovery_score[0],
                recovery_score[1],
                recovery_score[2],
                QUALITY_RANK.get(resolved_quality, -1),
                sample_rate,
                bit_depth,
                bitrate,
                recovery_score[3],
                recovery_score[4],
                recovery_score[5],
            )
            successful_candidates.append((
                stream_score,
                candidate,
                media_stream,
                stream_manifest,
                resolved_quality,
                format_recovery_trace_entry(candidate, resolved_quality, media_stream, stream_manifest, reference_track)
                + f" actual={actual_track_id}",
            ))
        except Exception as error:
            last_error = error
            recovery_trace.append(f"{getattr(candidate, 'id', 'unknown')}[failed:{str(error).strip() or error.__class__.__name__}]")
            if is_rate_limit_error(error):
                break
            continue

    if successful_candidates:
        successful_candidates.sort(key=lambda item: item[0], reverse=True)
        recovery_trace.extend(item[5] for item in successful_candidates)
        _, candidate, media_stream, stream_manifest, resolved_quality, _ = successful_candidates[0]
        return candidate, media_stream, stream_manifest, resolved_quality, recovery_trace

    if recovery_trace and last_error is not None:
        raise RuntimeError(f"{str(last_error).strip() or last_error.__class__.__name__} | recovery={ ' | '.join(recovery_trace[:12]) }")
    if last_error is not None:
        raise last_error
    raise RuntimeError("Could not resolve a playable TIDAL stream URL")


def ensure_browser_url(value: str | None) -> str:
    raw = (value or "").strip()
    if not raw:
        raise RuntimeError("TIDAL login did not return a verification URL")
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    return f"https://{raw.lstrip('/')}"


def fetch_all(fetcher: Callable[..., list[Any]], *, limit: int = 100) -> list[Any]:
    offset = 0
    items: list[Any] = []
    while True:
        page = retry_tidal_call(
            getattr(fetcher, "__name__", fetcher.__class__.__name__),
            lambda: fetcher(limit=limit, offset=offset),
        )
        items.extend(page)
        if len(page) < limit:
            break
        offset += len(page)
    return items


def fetch_all_best_effort(
    label: str,
    fetcher: Callable[..., list[Any]],
    *,
    limit: int = 100,
) -> list[Any]:
    try:
        return fetch_all(fetcher, limit=limit)
    except Exception as error:
        if is_transient_tidal_error(error):
            emit({
                "event": "transient_skip",
                "label": label,
                "error": str(error).strip() or error.__class__.__name__,
            })
            return []
        raise


def merge_tracks(*collections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for collection in collections:
        for track in collection:
            track_id = str(track.get("id", "")).strip()
            if not track_id:
                continue
            existing = merged.get(track_id)
            if existing is None:
                merged[track_id] = track
                continue

            if existing.get("album") is None and track.get("album") is not None:
                existing["album"] = track["album"]
            if not existing.get("artists") and track.get("artists"):
                existing["artists"] = track["artists"]
            if existing.get("artist") is None and track.get("artist") is not None:
                existing["artist"] = track["artist"]
            if existing.get("audioQuality") is None and track.get("audioQuality") is not None:
                existing["audioQuality"] = track["audioQuality"]
            for genre in track.get("genres") or []:
                add_payload_genre(existing, genre)
    return list(merged.values())


def fetch_genre_items_best_effort(genre_obj: Any, model: Any, label: str) -> list[Any]:
    try:
        return retry_tidal_call(label, lambda: genre_obj.items(model), attempts=2)
    except Exception as error:
        if is_transient_tidal_error(error):
            emit({
                "event": "transient_skip",
                "label": label,
                "error": str(error).strip() or error.__class__.__name__,
            })
        return []


def collect_payload_artists(payload: dict[str, Any], artists_by_id: dict[str, list[dict[str, Any]]]) -> None:
    candidates: list[Any] = []
    candidates.extend(payload.get("artists") or [])
    if payload.get("artist"):
        candidates.append(payload.get("artist"))
    album = payload.get("album")
    if isinstance(album, dict):
        candidates.extend(album.get("artists") or [])
        if album.get("artist"):
            candidates.append(album.get("artist"))

    for artist in candidates:
        if not isinstance(artist, dict):
            continue
        artist_id = str(artist.get("sourceId") or artist.get("id") or "").strip()
        if not artist_id:
            continue
        artists_by_id.setdefault(artist_id, []).append(artist)


def enrich_library_genres(session: tidalapi.Session, albums: list[dict[str, Any]], tracks: list[dict[str, Any]]) -> None:
    albums_by_id = {
        str(album.get("sourceId") or album.get("id") or "").strip(): album
        for album in albums
        if str(album.get("sourceId") or album.get("id") or "").strip()
    }
    tracks_by_id = {
        str(track.get("sourceId") or track.get("id") or "").strip(): track
        for track in tracks
        if str(track.get("sourceId") or track.get("id") or "").strip()
    }
    artists_by_id: dict[str, list[dict[str, Any]]] = {}
    for album in albums:
        collect_payload_artists(album, artists_by_id)
    for track in tracks:
        collect_payload_artists(track, artists_by_id)

    if not albums_by_id and not tracks_by_id and not artists_by_id:
        return

    try:
        genres = retry_tidal_call("genres", session.genre.get_genres, attempts=2)
    except Exception as error:
        if is_transient_tidal_error(error):
            emit({
                "event": "transient_skip",
                "label": "genres",
                "error": str(error).strip() or error.__class__.__name__,
            })
        return

    for genre_obj in genres:
        genre_name = str(getattr(genre_obj, "name", "") or "").strip()
        if not genre_name:
            continue

        if albums_by_id and bool(getattr(genre_obj, "albums", False)):
            for item in fetch_genre_items_best_effort(genre_obj, tidalapi.album.Album, f"genre.albums:{genre_name}"):
                album_id = str(getattr(item, "id", "") or "").strip()
                add_payload_genre(albums_by_id.get(album_id), genre_name)

        if tracks_by_id and bool(getattr(genre_obj, "tracks", False)):
            for item in fetch_genre_items_best_effort(genre_obj, tidalapi.media.Track, f"genre.tracks:{genre_name}"):
                track_id = str(getattr(item, "id", "") or "").strip()
                track_payload = tracks_by_id.get(track_id)
                add_payload_genre(track_payload, genre_name)
                album = track_payload.get("album") if isinstance(track_payload, dict) else None
                if isinstance(album, dict):
                    album_id = str(album.get("sourceId") or album.get("id") or "").strip()
                    add_payload_genre(albums_by_id.get(album_id), genre_name)
                    add_payload_genre(album, genre_name)

        if artists_by_id and bool(getattr(genre_obj, "artists", False)):
            for item in fetch_genre_items_best_effort(genre_obj, tidalapi.artist.Artist, f"genre.artists:{genre_name}"):
                artist_id = str(getattr(item, "id", "") or "").strip()
                for artist_payload in artists_by_id.get(artist_id, []):
                    add_payload_genre(artist_payload, genre_name)


def cmd_login(payload: dict[str, Any]) -> dict[str, Any]:
    session = make_session(payload)
    link, future = session.login_oauth()
    verification_uri = ensure_browser_url(link.verification_uri)
    verification_uri_complete = ensure_browser_url(link.verification_uri_complete)
    emit({
      "event": "login_url",
      "verificationUri": verification_uri,
      "verificationUriComplete": verification_uri_complete,
      "userCode": link.user_code,
      "expiresIn": link.expires_in,
    })
    future.result()
    return {
      "authorizationUrl": verification_uri_complete,
      "expiresAt": session_snapshot(session)["expiresAt"],
      "countryCode": session.country_code or "US",
    }, session_snapshot(session)


def cmd_session_info(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    return session_snapshot(session), session_snapshot(session)


def cmd_search(payload: dict[str, Any]) -> list[dict[str, Any]]:
    session = load_session(payload)
    results = session.search(str(payload.get("query", "")), limit=int(payload.get("limit", 25)))
    tracks = [serialize_search_track(track) for track in results.get("tracks", [])]
    return tracks, session_snapshot(session)


def cmd_catalog_search(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    limit = int(payload.get("limit", 12))
    playlist_model = getattr(getattr(tidalapi, "playlist", None), "Playlist", None)
    models = [tidalapi.artist.Artist, tidalapi.album.Album, tidalapi.media.Track]
    if playlist_model is not None:
        models.append(playlist_model)
    results = session.search(
        str(payload.get("query", "")),
        models=models,
        limit=limit,
    )
    return {
      "artists": [serialize_catalog_artist(artist) for artist in results.get("artists", [])],
      "albums": [serialize_catalog_album(album) for album in results.get("albums", [])],
      "tracks": [serialize_catalog_track(track) for track in results.get("tracks", [])],
      "playlists": dedupe_catalog_playlists([serialize_catalog_playlist(playlist) for playlist in results.get("playlists", [])]),
    }, session_snapshot(session)


def cmd_artist_bundle(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    artist_id = str(payload.get("artistId", "")).strip()
    if not artist_id:
        raise RuntimeError("Missing TIDAL artist id")

    limit = int(payload.get("limit", 32))
    artist = session.artist(artist_id)
    try:
        artist.bio = artist.get_bio()
    except Exception:
        artist.bio = None

    page_album_sections, page_playlists, page_album_items = fetch_artist_page_sections(artist, limit)
    top_tracks = artist.get_top_tracks(limit=min(max(limit, 25), 100))
    try:
        related = artist.get_similar()[: min(limit, 12)]
    except Exception:
        related = []

    releases = dedupe_by_id([*fetch_artist_discography(artist, limit), *page_album_items])

    serialized_releases = []
    for album in releases:
        serialized = serialize_catalog_album(album)
        page_section = page_album_sections.get(str(getattr(album, "id", "")))
        if page_section == "live":
            serialized["releaseSection"] = "live"
        elif page_section == "compilation":
            serialized["releaseSection"] = "compilation"
        elif page_section == "other":
            serialized["releaseSection"] = "other"
        elif page_section == "album":
            serialized["releaseSection"] = "album"
        elif page_section == "ep_single":
            if serialized.get("releaseType") == "ep":
                serialized["releaseSection"] = "ep"
            elif serialized.get("releaseType") == "single":
                serialized["releaseSection"] = "single"
            else:
                serialized["releaseSection"] = "single" if int(serialized.get("totalTracks") or 0) <= 1 else "ep"
        serialized_releases.append(serialized)

    return {
      "artist": serialize_catalog_artist(artist),
      "releases": serialized_releases,
      "playlists": dedupe_catalog_playlists([serialize_catalog_playlist(playlist) for playlist in page_playlists]),
      "topTracks": [serialize_catalog_track(track) for track in top_tracks],
      "relatedArtists": [serialize_catalog_artist(item) for item in related],
    }, session_snapshot(session)


def cmd_artist(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    artist_id = str(payload.get("artistId", "")).strip()
    if not artist_id:
        raise RuntimeError("Missing TIDAL artist id")

    artist = session.artist(artist_id)
    try:
        artist.bio = artist.get_bio()
    except Exception:
        artist.bio = None
    return serialize_catalog_artist(artist), session_snapshot(session)


def cmd_artist_genre_map(payload: dict[str, Any]) -> dict[str, list[str]]:
    session = load_session(payload)
    artist_ids = {
        str(artist_id).strip()
        for artist_id in payload.get("artistIds") or []
        if str(artist_id).strip()
    }
    if not artist_ids:
        return {}, session_snapshot(session)

    genre_map: dict[str, list[str]] = {artist_id: [] for artist_id in artist_ids}
    try:
        genres = retry_tidal_call("genres", session.genre.get_genres, attempts=2)
    except Exception as error:
        if is_transient_tidal_error(error):
            emit({
                "event": "transient_skip",
                "label": "genres",
                "error": str(error).strip() or error.__class__.__name__,
            })
        return genre_map, session_snapshot(session)

    for genre_obj in genres:
        genre_name = str(getattr(genre_obj, "name", "") or "").strip()
        if not genre_name or not bool(getattr(genre_obj, "artists", False)):
            continue
        for item in fetch_genre_items_best_effort(genre_obj, tidalapi.artist.Artist, f"genre.artists:{genre_name}"):
            artist_id = str(getattr(item, "id", "") or "").strip()
            if artist_id not in artist_ids:
                continue
            add_payload_genre({"genres": genre_map[artist_id]}, genre_name)

    return genre_map, session_snapshot(session)


def cmd_album_bundle(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    album_id = str(payload.get("albumId", "")).strip()
    if not album_id:
        raise RuntimeError("Missing TIDAL album id")

    album = session.album(album_id)
    tracks = fetch_album_tracks(album)
    return {
      "album": serialize_catalog_album(album),
      "tracks": [serialize_catalog_track(track) for track in tracks],
    }, session_snapshot(session)


def cmd_track_contributors(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    track_id = str(payload.get("trackId", "")).strip()
    if not track_id:
        raise RuntimeError("Missing TIDAL track id")

    track = session.track(track_id, with_album=True)
    album = getattr(track, "album", None)
    album_raw = fetch_album_raw(track)
    release_date = getattr(album, "release_date", None) or getattr(album, "tidal_release_date", None)

    return {
      "provider": "tidal",
      "sourceId": str(getattr(track, "id", track_id) or track_id),
      "providerUrl": getattr(track, "share_url", None),
      "albumId": str(getattr(album, "id", "")) if getattr(album, "id", None) is not None else None,
      "albumTitle": getattr(album, "name", None),
      "releaseDate": release_date.isoformat() if release_date else album_raw.get("releaseDate") or album_raw.get("streamStartDate"),
      "label": album_raw.get("label") or album_raw.get("publisher"),
      "copyright": getattr(track, "copyright", None) or getattr(album, "copyright", None) or album_raw.get("copyright"),
      "isrc": getattr(track, "isrc", None),
      "upc": getattr(album, "upc", None) or album_raw.get("upc"),
      "roles": fetch_track_contributors_payload(track),
    }, session_snapshot(session)


def cmd_add_to_library(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    entity_type = str(payload.get("entityType", "")).strip().lower()
    source_id = str(payload.get("sourceId", "")).strip()
    if not entity_type or not source_id:
        raise RuntimeError("Missing TIDAL add-to-library target")
    if session.user is None or not hasattr(session.user, "favorites"):
        raise RuntimeError("Logged-in TIDAL user profile is unavailable")

    favorites = session.user.favorites
    if entity_type == "artist":
        ok = favorites.add_artist(source_id)
    elif entity_type == "album":
        ok = favorites.add_album(source_id)
    elif entity_type == "track":
        ok = favorites.add_track(source_id)
    else:
        raise RuntimeError(f"Unsupported TIDAL library entity type: {entity_type}")

    if not ok:
        raise RuntimeError("TIDAL did not accept the add-to-library request")
    return {"ok": True}, session_snapshot(session)


def cmd_library_sync(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    if session.user is None or not hasattr(session.user, "favorites"):
        raise RuntimeError("Logged-in TIDAL user profile is unavailable")

    favorites = session.user.favorites
    favorite_albums = fetch_all_best_effort("favorites.albums", favorites.albums)
    albums = [serialize_album(album) for album in favorite_albums]
    saved_tracks = [serialize_track(track) for track in fetch_all_best_effort("favorites.tracks", favorites.tracks)]

    album_tracks_raw: list[dict[str, Any]] = []
    for album in favorite_albums:
        album_tracks_raw.extend(serialize_track(track) for track in fetch_all_best_effort(f"album.tracks:{getattr(album, 'id', 'unknown')}", album.tracks))

    if hasattr(session.user, "playlist_and_favorite_playlists"):
        playlists_raw = fetch_all_best_effort("user.playlist_and_favorite_playlists", session.user.playlist_and_favorite_playlists, limit=50)
    elif hasattr(session.user, "playlists"):
        playlists_raw = list(retry_tidal_call("user.playlists", lambda: list(session.user.playlists())))
    else:
        playlists_raw = []

    folder_structure = fetch_tidal_playlist_folder_structure(session)
    playlists: list[dict[str, Any]] = []
    playlist_tracks_raw: list[dict[str, Any]] = []
    for playlist in playlists_raw:
        items_raw = fetch_all_best_effort(f"playlist.tracks:{getattr(playlist, 'id', 'unknown')}", playlist.tracks, limit=100)
        items = [serialize_track(track) for track in items_raw]
        playlist_tracks_raw.extend(items)
        playlist_payload = serialize_playlist(playlist, items)
        source_id = str(playlist_payload.get("uuid") or playlist_payload.get("id") or "").strip()
        folder_assignment = folder_structure["playlistFolders"].get(source_id)
        if folder_assignment:
            playlist_payload["folderSourceId"] = folder_assignment.get("folderSourceId")
            playlist_payload["folderPosition"] = folder_assignment.get("position")
        playlists.append(playlist_payload)

    tracks = merge_tracks(saved_tracks, album_tracks_raw, playlist_tracks_raw)

    return {
      "albums": albums,
      "tracks": tracks,
      "playlists": playlists,
      "playlistFolders": folder_structure["folders"],
    }, session_snapshot(session)


def cmd_home_shelves(payload: dict[str, Any]) -> list[dict[str, Any]]:
    session = load_session(payload)
    shelves: dict[str, list[dict[str, Any]]] = {
        "tidal:listening-highlights": [],
        "tidal:personal-mixes": [],
    }
    seen: dict[str, set[str]] = {
        "tidal:listening-highlights": set(),
        "tidal:personal-mixes": set(),
    }

    page_sources: list[list[tuple[str | None, Any]]] = []
    for label, fetcher in (
        ("session.home", lambda: session.home()),
        ("session.mixes", lambda: session.mixes()),
        ("session.for_you", lambda: session.for_you()),
    ):
        try:
            page_sources.append(iter_page_category_items(retry_tidal_call(label, fetcher)))
        except Exception:
            continue

    for pairs in page_sources:
        for context_title, item in pairs:
            serialized = None
            if is_mix_like(item):
                serialized = serialize_home_mix(item)
            elif is_playlist_like(item):
                serialized = serialize_home_playlist(item)
            if serialized is None:
                continue

            shelf_id = classify_home_collection(serialized, context_title)
            if shelf_id is None:
                continue
            upsert_home_collection(shelves, seen, shelf_id, serialized)

    return [
        {
          "id": "tidal:listening-highlights",
          "provider": "tidal",
          "title": "TIDAL Listening Highlights",
          "subtitle": "Your listening rewind, monthly recaps, and yearly snapshots.",
          "items": shelves["tidal:listening-highlights"][:12],
        },
        {
          "id": "tidal:personal-mixes",
          "provider": "tidal",
          "title": "TIDAL Made for You",
          "subtitle": "Daily discovery and mixes tuned to what you play most.",
          "items": shelves["tidal:personal-mixes"][:12],
        },
    ], session_snapshot(session)


def cmd_home_collection(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    source_type = str(payload.get("sourceType", "") or "").strip().lower()
    source_id = str(payload.get("sourceId", "") or "").strip()
    if source_type not in ("playlist", "mix") or not source_id:
        raise RuntimeError("Missing TIDAL home collection target")

    if source_type == "playlist":
        collection = session.playlist(source_id)
        tracks = fetch_all_best_effort(f"playlist.tracks:{source_id}", collection.tracks, limit=100)
        payload_item = serialize_home_playlist(collection)
    else:
        collection = session.mix(source_id)
        try:
            tracks = list(collection.items())
        except Exception:
            tracks = []
        payload_item = serialize_home_mix(collection)

    return {
      "provider": "tidal",
      "sourceType": source_type,
      "sourceId": source_id,
      "title": payload_item.get("title") or "Collection",
      "subtitle": payload_item.get("subtitle"),
      "description": payload_item.get("description"),
      "artworkUrl": payload_item.get("artworkUrl"),
      "providerUrl": payload_item.get("providerUrl"),
      "tracks": [serialize_home_track(track) for track in tracks if getattr(track, "id", None) is not None],
    }, session_snapshot(session)


def cmd_playback_info(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    track_id = str(payload.get("trackId", "")).strip()
    if not track_id:
        raise RuntimeError("Missing TIDAL track id")

    output_dir = ensure_output_dir(payload.get("outputDir"))
    host_remux = payload.get("hostRemux") is True
    resolved_track, media_stream, stream_manifest, resolved_quality, recovery_trace = resolve_best_playable_track(
        session,
        track_id,
        payload.get("preferredQuality"),
        allow_recovery=bool(payload.get("allowRecovery", True)),
    )
    resolved_track_id = str(getattr(media_stream, "track_id", None) or getattr(resolved_track, "id", track_id) or track_id)
    file_extension = getattr(stream_manifest, "file_extension", None) or ".bin"
    codecs = str(getattr(stream_manifest, "codecs", "") or "").upper()
    sample_rate = int(getattr(stream_manifest, "sample_rate", 0) or getattr(media_stream, "sample_rate", 0) or 0)
    bit_depth = int(getattr(media_stream, "bit_depth", 0) or 0)
    can_output_flac = codecs == "FLAC" and (file_extension.lower() == ".flac" or host_remux)
    cache_stem = f"{resolved_track_id}-{resolved_quality.lower()}-{sample_rate or 0}-{bit_depth or 0}"
    cache_candidates = [output_dir / f"{cache_stem}{file_extension}"]
    if can_output_flac:
        cache_candidates.insert(0, output_dir / f"{cache_stem}.flac")
    cached_path = next((path for path in cache_candidates if path.exists() and path.stat().st_size > 0), cache_candidates[0])

    if not cached_path.exists() or cached_path.stat().st_size == 0:
        work_dir = output_dir / f".work-{uuid4().hex}"
        try:
            work_dir.mkdir(parents=True, exist_ok=True)
            merged_path = work_dir / f"{resolved_track_id}{file_extension}"
            emit({"event": "buffer_progress", "trackId": track_id, "progress": 0})
            merge_stream_urls_to_file(
                stream_manifest.get_urls(),
                merged_path,
                on_progress=lambda progress: emit({
                    "event": "buffer_progress",
                    "trackId": track_id,
                    "progress": progress,
                }),
            )
            playable_path = maybe_decrypt_file(merged_path, stream_manifest)
            cached_path = output_dir / f"{cache_stem}{playable_path.suffix.lower() or file_extension}"
            shutil.move(str(playable_path), str(cached_path))
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    return {
      "playbackPath": str(cached_path),
      "quality": describe_stream_format(media_stream, stream_manifest, resolved_quality),
      "resolvedQuality": resolved_quality,
      "resolvedTrackId": resolved_track_id,
      "recoveryTrace": recovery_trace,
      "hostRemux": host_remux and codecs == "FLAC" and cached_path.suffix.lower() != ".flac",
    }, session_snapshot(session)


def cmd_stream_manifest(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    track_id = str(payload.get("trackId", "")).strip()
    if not track_id:
        raise RuntimeError("Missing TIDAL track id")

    preferred_quality = payload.get("quality") or payload.get("preferredQuality")
    if bool(payload.get("allowRecovery", False)):
        resolved_track, media_stream, stream_manifest, resolved_quality, _recovery_trace = resolve_best_playable_track(
            session,
            track_id,
            preferred_quality,
            allow_recovery=True,
        )
    else:
        resolved_track = session.track(track_id, with_album=True)
        media_stream, stream_manifest, resolved_quality, _actual_track_id = select_first_playable_stream(
            resolved_track,
            preferred_quality,
        )
    urls = [str(url).strip() for url in stream_manifest.get_urls() if str(url).strip()]
    if not urls:
        raise RuntimeError("TIDAL stream manifest did not include segment URLs")

    resolved_track_id = str(
        getattr(media_stream, "track_id", None)
        or getattr(resolved_track, "id", track_id)
        or track_id
    )
    codec = str(getattr(stream_manifest, "codecs", "") or "").upper()
    sample_rate = int(
        getattr(stream_manifest, "sample_rate", 0)
        or getattr(media_stream, "sample_rate", 0)
        or 0
    )
    bit_depth = int(getattr(media_stream, "bit_depth", 0) or 0)
    encryption_key = getattr(stream_manifest, "encryption_key", None)
    replay_gain = getattr(media_stream, "track_replay_gain", None)

    return {
      "trackId": track_id,
      "resolvedTrackId": resolved_track_id,
      "resolvedQuality": resolved_quality,
      "codec": codec,
      "fileExtension": str(getattr(stream_manifest, "file_extension", None) or ""),
      "sampleRate": sample_rate or None,
      "bitDepth": bit_depth or None,
      "encrypted": bool(getattr(stream_manifest, "is_encrypted", False)),
      "urls": urls,
      "encryptionKey": str(encryption_key) if encryption_key else None,
      "replayGain": float(replay_gain) if replay_gain is not None else None,
    }, session_snapshot(session)


def cmd_format_info_batch(payload: dict[str, Any]) -> dict[str, Any]:
    session = load_session(payload)
    track_ids = payload.get("trackIds")
    if not isinstance(track_ids, list):
        raise RuntimeError("Missing TIDAL track ids")

    results: dict[str, dict[str, Any]] = {}
    for raw_track_id in track_ids:
        track_id = str(raw_track_id or "").strip()
        if not track_id:
            continue
        try:
            resolved_track, media_stream, stream_manifest, resolved_quality, _recovery_trace = resolve_best_playable_track(
                session,
                track_id,
                payload.get("preferredQuality"),
                allow_recovery=True,
            )
            results[track_id] = {
              "quality": describe_stream_format(media_stream, stream_manifest, resolved_quality),
              "resolvedQuality": resolved_quality,
              "resolvedTrackId": str(getattr(media_stream, "track_id", None) or getattr(resolved_track, "id", track_id) or track_id),
            }
        except Exception:
            continue

    return results, session_snapshot(session)


COMMANDS: dict[str, Callable[[dict[str, Any]], tuple[Any, dict[str, Any]]]] = {
  "login": cmd_login,
  "session-info": cmd_session_info,
  "search": cmd_search,
  "catalog-search": cmd_catalog_search,
  "artist": cmd_artist,
  "artist-genre-map": cmd_artist_genre_map,
  "artist-bundle": cmd_artist_bundle,
  "album-bundle": cmd_album_bundle,
  "track-contributors": cmd_track_contributors,
  "add-to-library": cmd_add_to_library,
  "library-sync": cmd_library_sync,
  "home-shelves": cmd_home_shelves,
  "home-collection": cmd_home_collection,
  "playback-info": cmd_playback_info,
  "stream_manifest": cmd_stream_manifest,
  "stream-manifest": cmd_stream_manifest,
  "format-info-batch": cmd_format_info_batch,
}


def main() -> int:
    if len(sys.argv) < 2:
        emit({"event": "result", "ok": False, "error": "Missing helper command"})
        return 1

    command = sys.argv[1]
    handler = COMMANDS.get(command)
    if handler is None:
        emit({"event": "result", "ok": False, "error": f"Unknown helper command: {command}"})
        return 1

    try:
        payload = read_payload()
        result, session = handler(payload)
        emit({
          "event": "result",
          "ok": True,
          "result": result,
          "session": session,
        })
        return 0
    except Exception as error:
        message = str(error).strip() or error.__class__.__name__
        if payload := locals().get("payload"):
            if payload.get("debug"):
                traceback.print_exc(file=sys.stderr)
        emit({
          "event": "result",
          "ok": False,
          "error": message,
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
