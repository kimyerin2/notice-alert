import React, { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
} from "firebase/firestore";
import { db } from "./firebase";
// 주의: 만약 style.css가 아니라 App.css를 사용하셨다면 아래를 "./App.css"로 바꿔주세요.
import "./style.css"; 

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
  if (!value) return "작성일 없음";
  if (typeof value === "string") return value;
  if (value?.toDate) return value.toDate().toLocaleDateString("ko-KR");
  return "작성일 없음";
}

export default function App() {
  const [notices, setNotices] = useState([]);
  const [status, setStatus] = useState("알림을 받으려면 버튼을 눌러주세요 💌");
  const [loading, setLoading] = useState(false);

  const [lastNoticeDoc, setLastNoticeDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [noticeLoading, setNoticeLoading] = useState(false);

  useEffect(() => {
    loadNotices({ reset: true });
  }, []);

  async function loadNotices({ reset = false } = {}) {
    try {
      setNoticeLoading(true);
      let noticeQuery;

      if (!reset && lastNoticeDoc) {
        noticeQuery = query(
          collection(db, "notices"),
          orderBy("date", "desc"),
          startAfter(lastNoticeDoc),
          limit(20)
        );
      } else {
        noticeQuery = query(
          collection(db, "notices"),
          orderBy("date", "desc"),
          limit(20)
        );
      }

      const snapshot = await getDocs(noticeQuery);
      const items = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      }));

      if (reset) {
        setNotices(items);
      } else {
        setNotices((prev) => [...prev, ...items]);
      }

      const lastDoc = snapshot.docs[snapshot.docs.length - 1] || null;
      setLastNoticeDoc(lastDoc);
      setHasMore(snapshot.docs.length === 20);
    } catch (error) {
      console.error(error);
      setStatus(`앗! 오류가 발생했어요: ${error.message} 💦`);
    } finally {
      setNoticeLoading(false);
    }
  }

  async function registerServiceWorker() {
    await navigator.serviceWorker.register("/sw.js");
    return await navigator.serviceWorker.ready;
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

    return subscriptionId;
  }

  async function subscribePush() {
    try {
      setLoading(true);
      setStatus("알림 받을 준비를 하고 있어요... 🪄");

      if (!("serviceWorker" in navigator)) {
        setStatus("지원하지 않는 브라우저예요 😢");
        return null;
      }
      if (!("PushManager" in window)) {
        setStatus("웹 푸시를 지원하지 않아요 😢");
        return null;
      }
      if (!("Notification" in window)) {
        setStatus("알림 기능을 지원하지 않아요 😢");
        return null;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("알림 권한을 허락해주세요! 🙏");
        return null;
      }

      const registration = await registerServiceWorker();
      const existingSubscription = await registration.pushManager.getSubscription();

      if (existingSubscription) {
        const subscriptionId = await saveSubscription(existingSubscription);
        setStatus("이미 예쁘게 알림을 받고 있어요! ✨");
        return subscriptionId;
      }

      const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!publicKey) {
        setStatus("열쇠(Public Key)가 없어요 🗝️");
        return null;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const subscriptionId = await saveSubscription(subscription);
      setStatus("짜잔! 알림 구독이 완료되었어요 🎉");
      return subscriptionId;
    } catch (error) {
      console.error(error);
      setStatus(`앗, 구독 중 오류가 생겼어요: ${error.message} 💦`);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function testPush() {
    try {
      setLoading(true);
      setStatus("테스트 알림을 보내볼게요... 🚀");

      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatus("지원하지 않는 브라우저예요 😢");
        return;
      }

      const registration = await registerServiceWorker();
      const existingSubscription = await registration.pushManager.getSubscription();
      let subscriptionId = null;

      if (existingSubscription) {
        subscriptionId = await saveSubscription(existingSubscription);
      } else {
        subscriptionId = await subscribePush();
      }

      if (!subscriptionId) {
        setStatus("알림 구독을 먼저 해주세요! 🎀");
        return;
      }

      await addDoc(collection(db, "push_test_requests"), {
        status: "pending",
        subscriptionId,
        createdAt: serverTimestamp(),
        userAgent: navigator.userAgent,
      });

      setStatus("테스트 요청 성공! 깃허브 액션이 곧 알림을 배달할 거예요 📮");
    } catch (error) {
      console.error(error);
      setStatus(`테스트 중 오류가 발생했어요: ${error.message} 💦`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      {/* 둥둥 떠다니는 장식 요소들 */}
      <div className="deco-star star-1">✨</div>
      <div className="deco-star star-2">☁️</div>
      <div className="deco-star star-3">🌷</div>

      <section className="hero wrapper-box">
        {/* 마스킹 테이프 장식 */}
        <div className="masking-tape"></div>
        <div className="hero-content">
          <h1>
            <span className="title-icon">🔔</span> 학교 공지 알림
          </h1>
          <p className="subtitle">
            서울여자대학교 지능정보보호학부의 <br />
            반짝이는 새 소식들을 모아 알려드릴게요!
          </p>

          <div className="button-row">
            <button className="btn-primary" onClick={subscribePush} disabled={loading}>
              {loading ? "처리 중... ⏳" : "알림 받기 💌"}
            </button>
            <button className="btn-secondary" type="button" onClick={testPush} disabled={loading}>
              알림 테스트 🪄
            </button>
          </div>
          <div className="status-box">
            <p className="status">{status}</p>
          </div>
        </div>
      </section>

      <section className="notice-section wrapper-box">
        <h2 className="section-title">
          <span>📌</span> 최근 올라온 소식들
        </h2>

        <div className="notice-container">
          {noticeLoading && notices.length === 0 ? (
            <div className="empty-state">소식들을 열심히 주워담고 있어요... 🧺</div>
          ) : notices.length === 0 ? (
            <div className="empty-state">아직 도착한 소식이 없어요 📭</div>
          ) : (
            <>
              <ul className="notice-list">
                {notices.map((notice) => (
                  <li key={notice.id} className="notice-item">
                    <div className="notice-card">
                      {/* 메모지 펀치 구멍 장식 */}
                      <div className="card-hole"></div>

                      <div className="notice-meta">
                        <span className="notice-date">
                          📅 {notice.date ? formatDate(notice.date) : formatDate(notice.createdAt)}
                        </span>
                        {notice.sourceName && (
                          <span className="notice-source">🏷️ {notice.sourceName}</span>
                        )}
                      </div>

                      {React.createElement(
                        "a",
                        {
                          href: notice.url,
                          target: "_blank",
                          rel: "noreferrer",
                          className: "notice-title"
                        },
                        notice.title
                      )}
                    </div>
                  </li>
                ))}
              </ul>

              {hasMore && (
                <div className="load-more-wrapper">
                  <button
                    className="btn-more"
                    type="button"
                    onClick={() => loadNotices()}
                    disabled={noticeLoading}
                  >
                    {noticeLoading ? "가져오는 중... 🏃‍♀️" : "더 볼래요 🧶"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}