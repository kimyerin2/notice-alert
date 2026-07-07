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
  return btoa(endpoint).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function formatDate(value) {
  if (!value) return "알 수 없음";
  if (typeof value === "string") return value;
  if (value?.toDate) {
    const d = value.toDate();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return "알 수 없음";
}

export default function App() {
  const [notices, setNotices] = useState([]);
  
  const [status, setStatus] = useState("시스템 네트워크 동기화 중...");
  const [isSubscribed, setIsSubscribed] = useState(false);
  
  const [loading, setLoading] = useState(false);
  const [lastNoticeDoc, setLastNoticeDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [noticeLoading, setNoticeLoading] = useState(false);
  
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    document.body.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  useEffect(() => {
    async function checkSubscriptionStatus() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setStatus("ERR : 알림 기능을 지원하지 않는 환경입니다.");
        return;
      }

      if (Notification.permission === "denied") {
        setStatus("DENIED : 알림 권한이 차단되었습니다.");
        setIsSubscribed(false);
        return;
      }

      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          const subscription = await registration.pushManager.getSubscription();
          if (subscription) {
            setStatus("SYS_OK : 시스템 알림망에 연결되어 있습니다.");
            setIsSubscribed(true);
          } else {
            setStatus("STANDBY : 알림 수신이 비활성화된 상태입니다.");
            setIsSubscribed(false);
          }
        } else {
          setStatus("STANDBY : 알림 수신이 비활성화된 상태입니다.");
          setIsSubscribed(false);
        }
      } catch (error) {
        console.error(error);
        setStatus("ERR : 상태를 확인할 수 없습니다.");
      }
    }

    checkSubscriptionStatus();
    loadNotices({ reset: true });
  }, []);

  async function loadNotices({ reset = false } = {}) {
    try {
      setNoticeLoading(true);
      let noticeQuery;

      if (!reset && lastNoticeDoc) {
        noticeQuery = query(collection(db, "notices"), orderBy("date", "desc"), startAfter(lastNoticeDoc), limit(20));
      } else {
        noticeQuery = query(collection(db, "notices"), orderBy("date", "desc"), limit(20));
      }

      const snapshot = await getDocs(noticeQuery);
      const items = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));

      if (reset) setNotices(items);
      else setNotices((prev) => [...prev, ...items]);

      const lastDoc = snapshot.docs[snapshot.docs.length - 1] || null;
      setLastNoticeDoc(lastDoc);
      setHasMore(snapshot.docs.length === 20);
    } catch (error) {
      console.error(error);
      setStatus(`DB_ERR : 데이터베이스 연결 실패 (${error.message})`);
    } finally {
      setNoticeLoading(false);
    }
  }

  const handleLoadMore = async (e) => {
    e.currentTarget.blur();
    const currentScrollY = window.scrollY;
    await loadNotices();
    setTimeout(() => {
      window.scrollTo({ top: currentScrollY, behavior: "smooth" });
    }, 50);
  };

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
      setStatus("CONNECTING : 보안 알림망에 접속을 시도합니다...");

      if (!("serviceWorker" in navigator)) { setStatus("ERR : 지원하지 않는 브라우저입니다."); return null; }
      if (!("PushManager" in window)) { setStatus("ERR : 웹 푸시 API가 차단되었습니다."); return null; }
      if (!("Notification" in window)) { setStatus("ERR : 알림 권한 시스템이 없습니다."); return null; }

      const permission = await Notification.requestPermission();
      if (permission === "denied") { setStatus("DENIED : 권한이 거부되었습니다. 기기 설정에서 허용해주세요."); return null; }
      if (permission !== "granted") { setStatus("STANDBY : 권한이 허용되지 않았습니다."); return null; }

      const registration = await registerServiceWorker();
      const existingSubscription = await registration.pushManager.getSubscription();

      if (existingSubscription) {
        const subscriptionId = await saveSubscription(existingSubscription);
        setStatus("SYS_OK : 이미 시스템 알림망에 연결되어 있습니다.");
        setIsSubscribed(true);
        return subscriptionId;
      }

      const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!publicKey) { setStatus("ERR : 인증 키가 누락되었습니다."); return null; }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const subscriptionId = await saveSubscription(subscription);
      setStatus("SUCCESS : 새 공지 알림이 활성화되었습니다.");
      setIsSubscribed(true);
      return subscriptionId;
    } catch (error) {
      console.error(error);
      setStatus(`ERR : 연결 실패 (${error.message})`);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function testPush() {
    try {
      setLoading(true);
      setStatus("PROCESSING : 테스트 패킷 전송을 준비 중입니다...");

      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatus("ERR : 필수 환경이 지원되지 않습니다."); return;
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
        setStatus("WARN : 테스트 전 알림 수신을 먼저 활성화해주세요."); return;
      }

      await addDoc(collection(db, "push_test_requests"), {
        status: "pending",
        subscriptionId,
        createdAt: serverTimestamp(),
        userAgent: navigator.userAgent,
      });

      setStatus("SUCCESS : 테스트 패킷이 발송되었습니다.");
    } catch (error) {
      console.error(error);
      setStatus(`ERR : 전송 실패 (${error.message})`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      {/* 둥둥 떠다니는 장식들 */}
      <div className="bg-deco bg-deco-1 interactive-float">SYS_RDY</div>
      <div className="bg-deco bg-deco-2 interactive-float">NET: OK</div>
      
      <div className="layout-grid">
        
        {/* 터미널 1: 제어 센터 (사이드바) */}
        <section className="terminal-window window-animate sidebar-section">
          <div className="terminal-header">
            <div className="header-title">
              <span className="icon-pulse">🔴</span> root@swu: ~/제어_센터
            </div>
            <button className="theme-toggle-btn bounce-hover" onClick={toggleTheme}>
              {theme === "light" ? "모드: ☀️ LIGHT" : "모드: 🌙 DARK"}
            </button>
          </div>
          
          <div className="terminal-body sidebar-body">
            <div className="neo-control-box">
              <div className="status-hero">
                <h1 className="hero-title">SWU PUSH LINK</h1>
                <div className={`status-badge ${isSubscribed ? "active" : ""}`}>
                  <span className="badge-dot"></span>
                  {isSubscribed ? "알림 수신중" : "수신 대기중"}
                </div>
              </div>

              <div className="btn-group neo-btns">
                <button className="neo-btn primary" onClick={subscribePush} disabled={loading}>
                  <span className="btn-deco"></span>
                  <span className="btn-text">{loading ? "처리중..." : "알림 활성화"}</span>
                </button>
                <button className="neo-btn secondary" onClick={testPush} disabled={loading}>
                  <span className="btn-deco"></span>
                  <span className="btn-text">{loading ? "처리중..." : "연결 테스트"}</span>
                </button>
              </div>
            </div>
            
            <div className="status-log neo-log">
              <span className="cursor blink">█</span> <span className="log-msg">{status}</span>
            </div>
          </div>
        </section>

        {/* 터미널 2: 데이터 리스트 (메인 패널) */}
        <section className="terminal-window window-animate delay-1 main-section">
          <div className="terminal-header">
            <div className="header-title">
              <span className="icon-pulse">🔴</span> root@swu: ~/최근_공지사항
            </div>
            <span className="controls">_ □ X</span>
          </div>
          
          <div className="terminal-body">
            <h2 className="section-title">&nbsp;공지 데이터베이스를 열람합니다.</h2>

            <div className="log-container">
              {noticeLoading && notices.length === 0 ? (
                <p className="sys-msg loading-pulse">데이터 수신 중...</p>
              ) : notices.length === 0 ? (
                <p className="sys-msg">수신된 공지가 없습니다.</p>
              ) : (
                <>
                  <ul className="log-tree">
                    {notices.map((notice) => (
                      <li key={notice.id} className="log-node">
                        <div className="node-title-row">
                          <span className="tree-branch">├─</span>
                          <a href={notice.url} target="_blank" rel="noreferrer" className="node-title-link wobbly-hover">
                            {notice.title}
                          </a>
                        </div>
                        <div className="node-meta-row">
                          <span className="tree-branch">│&nbsp;&nbsp;└─</span>
                          <span className="meta-tag date">작성: {notice.date ? formatDate(notice.date) : formatDate(notice.createdAt)}</span>
                          <span className="meta-tag src">분류: {notice.sourceName || "학부공지"}</span>
                        </div>
                      </li>
                    ))}
                    <li className="log-node tree-end">
                      <span className="tree-branch">└─</span> [ 탐색 종료 ]
                    </li>
                  </ul>

                  {hasMore && (
                    <button className="neo-btn outline-btn load-more" onClick={handleLoadMore} disabled={noticeLoading}>
                      <span className="btn-deco"></span>
                      <span className="btn-text">{noticeLoading ? "로딩중..." : "과거 기록 더보기"}</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
        
      </div>
    </main>
  );
}