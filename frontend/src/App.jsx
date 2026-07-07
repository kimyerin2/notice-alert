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
  
  const [status, setStatus] = useState("시스템 권한 및 네트워크 연결 확인 중...");
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
        setStatus("ERR: 푸시 알림을 지원하지 않는 브라우저입니다.");
        return;
      }

      if (Notification.permission === "denied") {
        setStatus("DENIED: 알림 권한이 차단되었습니다. 시스템 설정에서 허용하십시오.");
        setIsSubscribed(false);
        return;
      }

      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          const subscription = await registration.pushManager.getSubscription();
          if (subscription) {
            setStatus("SYS_OK: 대상 기기가 알림망에 연결되어 수신 중입니다.");
            setIsSubscribed(true);
          } else {
            setStatus("STANDBY: 현재 알림을 수신하지 않는 상태입니다.");
            setIsSubscribed(false);
          }
        } else {
          setStatus("STANDBY: 현재 알림을 수신하지 않는 상태입니다.");
          setIsSubscribed(false);
        }
      } catch (error) {
        console.error(error);
        setStatus("ERR: 기기 상태를 확인할 수 없습니다.");
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
      setStatus(`DB_ERR: 데이터베이스 연결 실패 (${error.message})`);
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
      setStatus("CONNECTING: 알림망에 접속을 시도합니다...");

      if (!("serviceWorker" in navigator)) { setStatus("ERR: 지원하지 않는 환경입니다."); return null; }
      if (!("PushManager" in window)) { setStatus("ERR: 웹 푸시 API가 차단되었습니다."); return null; }
      if (!("Notification" in window)) { setStatus("ERR: 알림 권한 시스템이 없습니다."); return null; }

      const permission = await Notification.requestPermission();
      if (permission === "denied") { setStatus("DENIED: 알림 권한이 차단되었습니다."); return null; }
      if (permission !== "granted") { setStatus("STANDBY: 알림 권한이 허용되지 않았습니다."); return null; }

      const registration = await registerServiceWorker();
      const existingSubscription = await registration.pushManager.getSubscription();

      if (existingSubscription) {
        const subscriptionId = await saveSubscription(existingSubscription);
        setStatus("SYS_OK: 이미 연결되어 있습니다. (수신 중)");
        setIsSubscribed(true);
        return subscriptionId;
      }

      const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!publicKey) { setStatus("ERR: VAPID 키가 누락되었습니다."); return null; }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const subscriptionId = await saveSubscription(subscription);
      setStatus("SUCCESS: 시스템 알림 수신이 활성화되었습니다.");
      setIsSubscribed(true);
      return subscriptionId;
    } catch (error) {
      console.error(error);
      setStatus(`ERR: 연결 실패 (${error.message})`);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function testPush() {
    try {
      setLoading(true);
      setStatus("PROCESSING: 테스트 패킷을 준비 중입니다...");

      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatus("ERR: 필수 환경이 지원되지 않습니다."); return;
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
        setStatus("WARN: 테스트 전 [시스템 연결]을 활성화하십시오."); return;
      }

      await addDoc(collection(db, "push_test_requests"), {
        status: "pending",
        subscriptionId,
        createdAt: serverTimestamp(),
        userAgent: navigator.userAgent,
      });

      setStatus("SUCCESS: 테스트 패킷이 발송되었습니다. 수신을 확인하십시오.");
    } catch (error) {
      console.error(error);
      setStatus(`ERR: 전송 실패 (${error.message})`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* 글래스모피즘을 위한 은은한 배경 오로라(블러) 효과 */}
      <div className="ambient-bg">
        <div className="blob blob-1"></div>
        <div className="blob blob-2"></div>
      </div>

      <main className="container">
        {/* 장식 요소 (유지하되 고급스럽게) */}
        <div className="bg-deco bg-deco-1 interactive-float">SYS_RDY</div>
        <div className="bg-deco bg-deco-2 interactive-float">NET: OK</div>
        
        {/* 제어 패널 (Glass Terminal) */}
        <section className="glass-window window-animate">
          <div className="glass-header">
            <div className="header-title">
              <span className={`status-dot ${isSubscribed ? "pulse-green" : "pulse-red"}`}></span>
              root@swu: ~/설정_및_제어
            </div>
            <button className="theme-toggle-btn" onClick={toggleTheme}>
              {theme === "light" ? "LIGHT" : "DARK"} MODE
            </button>
          </div>
          
          <div className="glass-body">
            {/* 꽉 찬 레이아웃 (좌측 상태 링 + 우측 컨트롤) */}
            <div className="dashboard-grid">
              
              {/* 시스템 상태 링 (이모지 대체) */}
              <div className="system-status-core">
                <div className={`core-ring ${isSubscribed ? "active" : ""}`}>
                  <div className="core-inner">
                    <span className="core-text">{isSubscribed ? "ON" : "OFF"}</span>
                  </div>
                </div>
                <div className="core-label">
                  [ NODE: {isSubscribed ? "CONNECTED" : "DISCONNECTED"} ]
                </div>
              </div>

              {/* 조작부 */}
              <div className="control-panel">
                <div className="panel-text">
                  <h2 className="panel-title">Push Notification Link</h2>
                  <p className="panel-desc">
                    학부 홈페이지의 새로운 공지사항 데이터를 실시간으로 모니터링하여 대상 기기로 시스템 푸시를 전송합니다.
                  </p>
                </div>
                
                <div className="btn-group-glass">
                  <button className="btn-glass primary" onClick={subscribePush} disabled={loading}>
                    {loading ? "처리중..." : "EXEC: ./시스템_연결_활성화"}
                  </button>
                  <button className="btn-glass secondary" onClick={testPush} disabled={loading}>
                    {loading ? "처리중..." : "EXEC: ./테스트_패킷_전송"}
                  </button>
                </div>
              </div>
            </div>

            {/* 터미널 로그 출력부 */}
            <div className="glass-terminal-log">
              <span className="cursor blink">█</span>
              <span className="log-msg">{status}</span>
            </div>
          </div>
        </section>

        {/* 데이터 리스트 패널 */}
        <section className="glass-window window-animate delay-1">
          <div className="glass-header">
            <div className="header-title">
              <span className="status-dot gray"></span> root@swu: ~/최근_수신_데이터
            </div>
            <span className="controls">_ □ X</span>
          </div>
          
          <div className="glass-body">
            <h2 className="section-title">&nbsp;DB_STREAM: Fetching recent nodes...</h2>

            <div className="log-container">
              {noticeLoading && notices.length === 0 ? (
                <p className="sys-msg loading-pulse">데이터를 수신하고 있습니다...</p>
              ) : notices.length === 0 ? (
                <p className="sys-msg">수신된 데이터가 없습니다.</p>
              ) : (
                <>
                  <ul className="log-tree">
                    {notices.map((notice) => (
                      <li key={notice.id} className="log-node">
                        <div className="node-title-row">
                          <span className="tree-branch">├─</span>
                          <a href={notice.url} target="_blank" rel="noreferrer" className="node-title-link">
                            {notice.title}
                          </a>
                        </div>
                        <div className="node-meta-row">
                          <span className="tree-branch">│&nbsp;&nbsp;└─</span>
                          <span className="glass-tag date">작성: {notice.date ? formatDate(notice.date) : formatDate(notice.createdAt)}</span>
                          <span className="glass-tag src">분류: {notice.sourceName || "학부공지"}</span>
                        </div>
                      </li>
                    ))}
                    <li className="log-node tree-end">
                      <span className="tree-branch">└─</span> [ 탐색 종료 : EOF ]
                    </li>
                  </ul>

                  {hasMore && (
                    <button className="btn-glass load-more" onClick={handleLoadMore} disabled={noticeLoading}>
                      {noticeLoading ? "로딩중..." : "CMD: fetch_older_records"}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      </main>
    </>
  );
}