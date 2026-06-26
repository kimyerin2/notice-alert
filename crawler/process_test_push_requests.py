import os
import json
import logging
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import credentials, firestore

from google.cloud.firestore_v1 import FieldFilter

from pywebpush import webpush, WebPushException


LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY")
VAPID_CLAIMS_SUB = os.getenv("VAPID_CLAIMS_SUB", "mailto:example@example.com")


logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)


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


def send_push_to_subscription(db, subscription_id, payload):
    if not VAPID_PRIVATE_KEY:
        raise RuntimeError("VAPID_PRIVATE_KEY is missing.")

    sub_ref = db.collection("push_subscriptions").document(subscription_id)
    sub_doc = sub_ref.get()

    if not sub_doc.exists:
        logging.warning("Subscription document does not exist. id=%s", subscription_id)
        return 0, 1

    sub_data = sub_doc.to_dict() or {}

    if not sub_data.get("active"):
        logging.warning("Subscription is not active. id=%s", subscription_id)
        return 0, 1

    subscription_info = sub_data.get("subscription")

    if not subscription_info:
        logging.warning("Subscription data is empty. id=%s", subscription_id)
        return 0, 1

    try:
        webpush(
            subscription_info=subscription_info,
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={
                "sub": VAPID_CLAIMS_SUB,
            },
        )

        return 1, 0

    except WebPushException as e:
        logging.warning("Push failed. subscriptionId=%s error=%s", subscription_id, e)

        status_code = getattr(getattr(e, "response", None), "status_code", None)

        if status_code in [404, 410]:
            sub_ref.update({
                "active": False,
                "disabledAt": datetime.now(timezone.utc),
                "disabledReason": f"HTTP {status_code}",
            })

        return 0, 1

    except Exception as e:
        logging.warning("Unexpected push error. subscriptionId=%s error=%s", subscription_id, e)
        return 0, 1


def main():
    logging.info("Test push processor started")

    db = init_firestore()
    now = datetime.now(timezone.utc)

    pending_requests = (
        db.collection("push_test_requests")
        .where(filter=FieldFilter("status", "==", "pending"))
        .stream()
    )

    processed_count = 0

    for request_doc in pending_requests:
        request_data = request_doc.to_dict() or {}

        subscription_id = request_data.get("subscriptionId")

        if not subscription_id:
            logging.warning("Request has no subscriptionId. id=%s", request_doc.id)
            request_doc.reference.update({
                "status": "failed",
                "failedAt": now,
                "failedReason": "missing subscriptionId",
            })
            continue

        logging.info("Processing test push request: %s", request_doc.id)

        request_doc.reference.update({
            "status": "processing",
            "processingAt": now,
        })

        payload = {
            "title": "알림 테스트",
            "body": "백그라운드 Web Push 알림이 정상 동작합니다.",
            "url": "/",
            "source": "test-push",
        }

        sent_count, failed_count = send_push_to_subscription(
            db=db,
            subscription_id=subscription_id,
            payload=payload,
        )

        next_status = "sent" if sent_count > 0 else "failed"

        request_doc.reference.update({
            "status": next_status,
            "sentAt": datetime.now(timezone.utc),
            "sentCount": sent_count,
            "failedCount": failed_count,
        })

        logging.info(
            "Test push processed. requestId=%s status=%s sent=%d failed=%d",
            request_doc.id,
            next_status,
            sent_count,
            failed_count,
        )

        processed_count += 1

    logging.info("Processed test requests count: %d", processed_count)
    logging.info("Test push processor finished")


if __name__ == "__main__":
    main()