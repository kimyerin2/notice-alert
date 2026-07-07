import os
import re
import json
import html
import time
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


SOURCES = [
    {
        "source_key": "swu-security",
        "source_name": "지능정보보호학부",
        "base_url": "http://security.swu.ac.kr/",
        "list_url": "http://security.swu.ac.kr/sub.html?page=community_notice",
        "page_url_template": "http://security.swu.ac.kr/sub.html?page=community_notice&page1={page}&searchKey=&searchValue=",
        "max_pages": 10,
        "view_keyword": "community_notice_view",
    }
]

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
    text = normalize_text(text)

    patterns = [
        r"(20\d{2})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})",
        r"(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일",
    ]

    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            year, month, day = match.groups()
            return f"{year}-{int(month):02d}-{int(day):02d}"

    return None


def make_notice_id(source_key, url):
    match = re.search(r"[?&]idx=(\d+)", url)

    if match:
        return f"{source_key}-{match.group(1)}"

    hashed = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return f"{source_key}-{hashed[:16]}"


def init_firestore():
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


def enrich_notice_from_detail(notice):
    if notice.get("date"):
        return notice

    try:
        detail_html = fetch_html(notice["url"])
        soup = BeautifulSoup(detail_html, "html.parser")
        page_text = normalize_text(soup.get_text(" ", strip=True))

        detail_date = extract_date_from_text(page_text)

        if detail_date:
            notice["date"] = detail_date
            logging.info("Date enriched: %s -> %s", notice["title"], detail_date)

        time.sleep(0.15)

    except Exception as e:
        logging.warning(
            "Failed to enrich date. title=%s url=%s error=%s",
            notice.get("title"),
            notice.get("url"),
            e,
        )

    return notice


def get_list_urls(source):
    urls = [source["list_url"]]

    page_url_template = source.get("page_url_template")
    max_pages = source.get("max_pages", 1)

    if page_url_template:
        for page in range(2, max_pages + 1):
            urls.append(page_url_template.format(page=page))

    return urls


def crawl_source(source):
    notices = []
    seen_urls = set()

    list_urls = get_list_urls(source)

    for page_index, list_url in enumerate(list_urls, start=1):
        try:
            logging.info(
                "Crawling list page. source=%s page=%d url=%s",
                source["source_name"],
                page_index,
                list_url,
            )

            html_text = fetch_html(list_url)
            soup = BeautifulSoup(html_text, "html.parser")

            page_notice_count = 0

            for a_tag in soup.find_all("a", href=True):
                href = a_tag["href"]

                if source["view_keyword"] not in href:
                    continue

                url = urljoin(source["base_url"], href)

                if url in seen_urls:
                    continue

                seen_urls.add(url)

                title = normalize_text(a_tag.get_text(" ", strip=True))

                parent = a_tag.find_parent(["tr", "li", "div"])
                parent_text = normalize_text(parent.get_text(" ", strip=True)) if parent else ""

                date = extract_date_from_text(parent_text)

                if not title:
                    title = parent_text

                if not title:
                    logging.warning("Skipped notice with empty title. url=%s", url)
                    continue

                notice = {
                    "id": make_notice_id(source["source_key"], url),
                    "title": title,
                    "url": url,
                    "date": date,
                    "sourceKey": source["source_key"],
                    "sourceName": source["source_name"],
                }

                notice = enrich_notice_from_detail(notice)

                notices.append(notice)
                page_notice_count += 1

            logging.info(
                "Crawled list page. source=%s page=%d count=%d",
                source["source_name"],
                page_index,
                page_notice_count,
            )

            time.sleep(0.2)

        except Exception as e:
            logging.warning(
                "List page crawl failed. source=%s page=%d url=%s error=%s",
                source["source_name"],
                page_index,
                list_url,
                e,
            )

    logging.info(
        "Crawled source. source=%s total_count=%d",
        source["source_name"],
        len(notices),
    )

    return notices


def crawl_notices():
    all_notices = []

    for source in SOURCES:
        try:
            notices = crawl_source(source)
            all_notices.extend(notices)
        except Exception as e:
            logging.warning(
                "Source crawl failed. source=%s error=%s",
                source["source_name"],
                e,
            )

    return all_notices


def save_notices_to_firestore(db, notices):
    new_notices = []
    duplicate_count = 0
    updated_date_count = 0

    for notice in notices:
        doc_ref = db.collection("notices").document(notice["id"])
        doc = doc_ref.get()

        if doc.exists:
            duplicate_count += 1

            existing_data = doc.to_dict() or {}
            existing_date = existing_data.get("date")
            new_date = notice.get("date")

            updates = {}

            if new_date and not existing_date:
                updates["date"] = new_date
                updates["updatedAt"] = datetime.now(timezone.utc)
                updated_date_count += 1

            if notice.get("sourceName") and not existing_data.get("sourceName"):
                updates["sourceName"] = notice["sourceName"]

            if notice.get("sourceKey") and not existing_data.get("sourceKey"):
                updates["sourceKey"] = notice["sourceKey"]

            if updates:
                doc_ref.update(updates)
                logging.info(
                    "Updated existing notice. title=%s updates=%s",
                    notice["title"],
                    list(updates.keys()),
                )
            else:
                logging.debug("Duplicate skipped: %s", notice["title"])

            continue

        now = datetime.now(timezone.utc)

        data = {
            "title": notice["title"],
            "url": notice["url"],
            "date": notice.get("date"),
            "sourceKey": notice.get("sourceKey"),
            "sourceName": notice.get("sourceName"),
            "createdAt": now,
            "updatedAt": now,
        }

        doc_ref.set(data)
        new_notices.append(notice)

        logging.info(
            "New notice saved: [%s] %s",
            notice.get("sourceName"),
            notice["title"],
        )
        logging.info("Notice URL: %s", notice["url"])

    return new_notices, duplicate_count, updated_date_count


def build_push_payload(notice):
    source_name = notice.get("sourceName", "학교 공지")

    return {
        "title": f"[{source_name}] 새 공지",
        "body": notice["title"],
        "url": notice["url"],
        "date": notice.get("date"),
        "source": source_name,
    }


def send_web_push_to_all(db, notice):
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
        sub_data = sub_doc.to_dict() or {}
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

    logging.info("Total crawled notices count: %d", len(notices))

    if not notices:
        logging.warning("No notices crawled. Process finished.")
        return

    new_notices, duplicate_count, updated_date_count = save_notices_to_firestore(db, notices)

    logging.info("Duplicate notices count: %d", duplicate_count)
    logging.info("Updated missing date count: %d", updated_date_count)
    logging.info("New notices count: %d", len(new_notices))

    notify_new_notices(db, new_notices)

    logging.info("Crawler finished")


if __name__ == "__main__":
    main()