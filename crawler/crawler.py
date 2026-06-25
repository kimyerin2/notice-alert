import os
import re
import json
import html
import hashlib
import logging
from datetime import datetime, timezone
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

import firebase_admin
from firebase_admin import credentials, firestore

from google.cloud.firestore_v1 import FieldFilter

from pywebpush import webpush, WebPushException


BASE_URL = "http://security.swu.ac.kr/"
NOTICE_LIST_URL = "http://security.swu.ac.kr/sub.html?page=community_notice"
SOURCE_NAME = "swu-security-notice"

INIT_MODE = os.getenv("INIT_MODE", "false").lower() == "true"
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY")
VAPID_CLAIMS_SUB = os.getenv("VAPID_CLAIMS_SUB", "mailto:example@example.com")

REQUEST_TIMEOUT = 15


logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)


def normalize_text(text):
    text = html.unescape(text or "")
    return re.sub(r"\s+", " ", text).strip()


def extract_date_from_text(text):
    """
    날짜 형태 추출:
    - 2026.03.18
    - 2026-03-18
    - 2026/03/18
    """
    text = normalize_text(text)

    match = re.search(r"(20\d{2})[./-](\d{1,2})[./-](\d{1,2})", text)

    if not match:
        return None

    year, month, day = match.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


def make_notice_id(url):
    """
    URL의 idx 값을 Firestore 문서 ID로 사용합니다.
    예:
    idx=1642 -> swu-security-1642
    """
    match = re.search(r"[?&]idx=(\d+)", url)

    if match:
        return f"swu-security-{match.group(1)}"

    hashed = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return f"swu-security-{hashed[:16]}"


def init_firestore():
    """
    로컬:
      crawler/firebase-service-account.json 사용

    GitHub Actions:
      FIREBASE_SERVICE_ACCOUNT_JSON 환경변수 사용
    """
    if firebase_admin._apps:
        return firestore.client()

    service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")

    if service_account_json:
        service_account_info = json.loads(service_account_json)
        cred = credentials.Certificate(service_account_info)
        firebase_admin.initialize_app(cred)
        logging.info("Firebase initialized from FIREBASE_SERVICE_ACCOUNT_JSON")
        return firestore.client()

    service_account_path = os.getenv(
        "FIREBASE_SERVICE_ACCOUNT_PATH",
        "firebase-service-account.json",
    )

    cred = credentials.Certificate(service_account_path)
    firebase_admin.initialize_app(cred)
    logging.info("Firebase initialized from local service account file")

    return firestore.client()


def fetch_html(url):
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; SchoolNoticeBot/1.0)"
    }

    response = requests.get(
        url,
        headers=headers,
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()

    response.encoding = response.apparent_encoding

    return response.text


def crawl_notices():
    html_text = fetch_html(NOTICE_LIST_URL)
    soup = BeautifulSoup(html_text, "html.parser")

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

        if not title:
            logging.warning("Skipped notice with empty title. url=%s", url)
            continue

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
    이미 존재하는 문서는 중복으로 판단하고 저장하지 않습니다.
    """
    new_notices = []
    duplicate_count = 0

    for notice in notices:
        doc_ref = db.collection("notices").document(notice["id"])
        doc = doc_ref.get()

        if doc.exists:
            duplicate_count += 1
            logging.debug("Duplicate skipped: %s", notice["title"])
            continue

        now = datetime.now(timezone.utc)

        data = {
            "title": notice["title"],
            "url": notice["url"],
            "date": notice["date"],
            "source": notice["source"],
            "createdAt": now,
        }

        doc_ref.set(data)
        new_notices.append(notice)

        logging.info("New notice saved: %s", notice["title"])
        logging.info("Notice URL: %s", notice["url"])

    return new_notices, duplicate_count


def build_push_payload(notice):
    return {
        "title": "새 학과 공지사항",
        "body": notice["title"],
        "url": notice["url"],
        "date": notice.get("date"),
        "source": notice.get("source", SOURCE_NAME),
    }


def send_web_push_to_all(db, notice):
    """
    Firestore push_subscriptions 컬렉션에 저장된 구독자에게 Web Push를 보냅니다.

    아직 프론트엔드를 만들기 전이면 구독자가 0명이므로 sent=0이 정상입니다.
    """
    if not VAPID_PRIVATE_KEY:
        logging.warning("VAPID_PRIVATE_KEY is missing. Push skipped.")
        return

    payload = json.dumps(build_push_payload(notice), ensure_ascii=False)

    subscriptions = (
        db.collection("push_subscriptions")
        .where(filter=FieldFilter("active", "==", True))
        .stream()
    )

    sent_count = 0
    failed_count = 0

    for sub_doc in subscriptions:
        sub_data = sub_doc.to_dict()
        subscription_info = sub_data.get("subscription")

        if not subscription_info:
            logging.warning("Subscription data is empty. documentId=%s", sub_doc.id)
            continue

        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={
                    "sub": VAPID_CLAIMS_SUB,
                },
            )

            sent_count += 1

        except WebPushException as e:
            failed_count += 1
            logging.warning("Push failed. subscriptionId=%s error=%s", sub_doc.id, e)

            status_code = getattr(getattr(e, "response", None), "status_code", None)

            if status_code in [404, 410]:
                sub_doc.reference.update({
                    "active": False,
                    "disabledAt": datetime.now(timezone.utc),
                    "disabledReason": f"HTTP {status_code}",
                })
                logging.info("Disabled expired subscription: %s", sub_doc.id)

        except Exception as e:
            failed_count += 1
            logging.warning(
                "Unexpected push error. subscriptionId=%s error=%s",
                sub_doc.id,
                e,
            )

    logging.info(
        "Push result for notice '%s': sent=%d failed=%d",
        notice["title"],
        sent_count,
        failed_count,
    )


def notify_new_notices(db, new_notices):
    if INIT_MODE:
        logging.info("INIT_MODE=true. Notifications are skipped.")
        return

    if not new_notices:
        logging.info("No new notices. Notification step skipped.")
        return

    logging.info("Sending Web Push notifications. New notice count: %d", len(new_notices))

    for notice in new_notices:
        send_web_push_to_all(db, notice)


def main():
    logging.info("Crawler started")
    logging.info("INIT_MODE=%s", INIT_MODE)
    logging.info("LOG_LEVEL=%s", LOG_LEVEL)

    db = init_firestore()

    notices = crawl_notices()

    logging.info("Crawled notices count: %d", len(notices))

    if not notices:
        logging.warning("No notices crawled. Process finished.")
        return

    new_notices, duplicate_count = save_notices_to_firestore(db, notices)

    logging.info("Duplicate notices count: %d", duplicate_count)
    logging.info("New notices count: %d", len(new_notices))

    if new_notices:
        logging.info("New notice summary:")
        for notice in new_notices:
            logging.info(
                "- %s | %s | %s",
                notice["title"],
                notice["date"],
                notice["url"],
            )

    notify_new_notices(db, new_notices)

    logging.info("Crawler finished")


if __name__ == "__main__":
    main()