import os
import re
import json
import hashlib
from datetime import datetime, timezone
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

import firebase_admin
from firebase_admin import credentials, firestore


BASE_URL = "http://security.swu.ac.kr/"
NOTICE_LIST_URL = "http://security.swu.ac.kr/sub.html?page=community_notice"

SOURCE_NAME = "swu-security-notice"

# 첫 실행 여부
# true면 기존 공지를 저장만 하고, 알림은 보내지 않는 용도
INIT_MODE = os.getenv("INIT_MODE", "false").lower() == "true"


def normalize_text(text):
    return re.sub(r"\s+", " ", text or "").strip()


def extract_date_from_text(text):
    """
    날짜 형태 추출:
    2026.03.18
    2026-03-18
    """
    match = re.search(r"(20\d{2})\d{1,2}\d{1,2}", text)
    if not match:
        return None

    year, month, day = match.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


def make_notice_id(url):
    """
    URL 안에 idx=숫자가 있으면 그걸 고유 ID로 사용.
    예:
    http://...idx=1642
    → swu-security-1642
    """
    match = re.search(r"[?&]idx=(\d+)", url)

    if match:
        return f"swu-security-{match.group(1)}"

    # 혹시 idx가 없으면 URL 해시 사용
    hashed = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return f"swu-security-{hashed[:16]}"


def init_firestore():
    """
    로컬에서는 crawler/firebase-service-account.json 파일을 사용합니다.
    """
    if firebase_admin._apps:
        return firestore.client()

    service_account_path = os.getenv(
        "FIREBASE_SERVICE_ACCOUNT_PATH",
        "firebase-service-account.json"
    )

    cred = credentials.Certificate(service_account_path)
    firebase_admin.initialize_app(cred)

    return firestore.client()


def crawl_notices():
    headers = {
        "User-Agent": "Mozilla/5.0"
    }

    response = requests.get(
        NOTICE_LIST_URL,
        headers=headers,
        timeout=15,
    )
    response.raise_for_status()

    response.encoding = response.apparent_encoding

    soup = BeautifulSoup(response.text, "html.parser")

    notices = []
    seen_urls = set()

    for a_tag in soup.find_all("a", href=True):
        href = a_tag["href"]

        if "community_notice_view" not in href:
            continue

        url = urljoin(BASE_URL, href)

        if url in seen_urls:
            continue

        seen_urls.add(url)

        title = normalize_text(a_tag.get_text(" ", strip=True))

        parent = a_tag.find_parent(["tr", "li", "div"])
        parent_text = normalize_text(parent.get_text(" ", strip=True)) if parent else ""

        date = extract_date_from_text(parent_text)

        notice = {
            "id": make_notice_id(url),
            "title": title,
            "url": url,
            "date": date,
            "source": SOURCE_NAME,
        }

        notices.append(notice)

    return notices


def save_notices_to_firestore(db, notices):
    """
    Firestore notices 컬렉션에 저장합니다.
    이미 있는 공지는 저장하지 않습니다.
    """
    new_notices = []

    for notice in notices:
        notice_id = notice["id"]

        doc_ref = db.collection("notices").document(notice_id)
        doc = doc_ref.get()

        if doc.exists:
            print(f"이미 있음, 스킵: {notice['title']}")
            continue

        data = {
            "title": notice["title"],
            "url": notice["url"],
            "date": notice["date"],
            "source": notice["source"],
            "createdAt": datetime.now(timezone.utc),
        }

        doc_ref.set(data)

        new_notices.append(notice)

        print(f"새 공지 저장 완료: {notice['title']}")

    return new_notices


def main():
    print("크롤러 시작")
    print(f"INIT_MODE = {INIT_MODE}")

    db = init_firestore()

    notices = crawl_notices()

    print(f"크롤링된 공지 수: {len(notices)}")

    if len(notices) == 0:
        print("공지 없음. 종료합니다.")
        return

    new_notices = save_notices_to_firestore(db, notices)

    print(f"새로 저장된 공지 수: {len(new_notices)}")

    if INIT_MODE:
        print("INIT_MODE=true 이므로 알림은 보내지 않습니다.")
    else:
        print("나중에 여기서 Web Push 알림을 보낼 예정입니다.")

    print("크롤러 종료")


if __name__ == "__main__":
    main()
