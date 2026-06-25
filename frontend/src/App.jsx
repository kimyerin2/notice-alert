import { useEffect, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "./firebase";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

function makeSubscriptionId(endpoint) {
  return btoa(endpoint)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function formatDate(value) {
  if (!value) {
    return "작성일 없음";
  }

  if (typeof value === "string") {
    return value;
  }

  if (value?.toDate) {
    return value.toDate().toLocaleDateString("ko-KR");
  }

  return "작성일 없음";
}

export default function App() {
  const [notices, setNotices] = useState([]);
  const [status, setStatus] = useState("알림을 받으려면 버튼을 눌러주세요.");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadNotices();
  }, []);

  async function loadNotices() {
    const q = query(
      collection(db, "notices"),
      orderBy("createdAt", "desc"),
      limit(20)
    );

    const snapshot = await getDocs(q);

    const items = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));

    setNotices(items);
  }

  async function subscribePush() {
    try {
      setLoading(true);
      setStatus("알림 구독을 준비하는 중입니다...");

      if (!("serviceWorker" in navigator)) {
        setStatus("이 브라우저는 Service Worker를 지원하지 않습니다.");
        return;
      }

      if (!("PushManager" in window)) {
        setStatus("이 브라우저는 Web Push를 지원하지 않습니다.");
        return;
      }

      if (!("Notification" in window)) {
        setStatus("이 브라우저는 알림 기능을 지원하지 않습니다.");
        return;
      }

      const permission = await Notification.requestPermission();

      if (permission !== "granted") {
        setStatus("알림 권한이 허용되지 않았습니다.");
        return;
      }

      await navigator.serviceWorker.register("/sw.js");

      // 핵심 수정:
      // Service Worker가 실제로 active 상태가 될 때까지 기다림
      const registration = await navigator.serviceWorker.ready;

      const existingSubscription = await registration.pushManager.getSubscription();

      if (existingSubscription) {
        await saveSubscription(existingSubscription);
        setStatus("이미 알림 구독이 등록되어 있습니다.");
        return;
      }

      const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;

      if (!publicKey) {
        setStatus("VAPID Public Key가 설정되지 않았습니다.");
        return;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      await saveSubscription(subscription);

      setStatus("알림 구독이 완료되었습니다.");
    } catch (error) {
      console.error(error);
      setStatus(`알림 구독 중 오류가 발생했습니다: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveSubscription(subscription) {
    const subscriptionJson = subscription.toJSON();
    const subscriptionId = makeSubscriptionId(subscriptionJson.endpoint);

    await setDoc(
      doc(db, "push_subscriptions", subscriptionId),
      {
        subscription: subscriptionJson,
        active: true,
        userAgent: navigator.userAgent,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }

  return (
    <main className="container">
      <section className="hero">
        <h1>학교 공지 알림</h1>
        <p>
          서울여자대학교 지능정보보호학부 공지사항을 확인하고 새 공지 알림을 받을 수 있습니다.
        </p>

        <button onClick={subscribePush} disabled={loading}>
          {loading ? "처리 중..." : "알림 받기"}
        </button>

        <p className="status">{status}</p>
      </section>

      <section className="notice-section">
        <h2>최근 공지</h2>

        {notices.length === 0 ? (
          <p>저장된 공지가 없습니다.</p>
        ) : (
          <ul className="notice-list">
            {notices.map((notice) => (
              <li key={notice.id} className="notice-item">
                <a href={notice.url} target="_blank" rel="noreferrer">
                  {notice.title}
                </a>
                <span>
                  {notice.date
                    ? `작성일 ${formatDate(notice.date)}`
                    : `저장일 ${formatDate(notice.createdAt)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}