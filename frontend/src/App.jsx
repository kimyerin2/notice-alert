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
  const [status, setStatus] = useState("[대기중] 시스템 정상. 사용자 입력을 기다립니다...");
  const [loading, setLoading] = useState(false);
  const [lastNoticeDoc, setLastNoticeDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [noticeLoading, setNoticeLoading] = useState(false);
  
  // 🌙 다크/라이트 모드 (기본: 라이트)
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    document.body.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  useEffect(() => {
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
      setStatus(`[오류] 데이터베이스 연결 실패: ${error.message}`);
    } finally {
      setNoticeLoading(false);
    }
  }

  // ✨ 스크롤 튕김 방지용 더보기 함수
  const handleLoadMore = async (e) => {
    // 1. 버튼 포커스를 강제로 풀어 브라우저가 화면을 끌어내리는 것을 방지
    e.currentTarget.blur();
    
    // 2. 현재 보던 스크롤 위치를 기억
    const currentScrollY = window.scrollY;
    
    await loadNotices();
    
    // 3. 목록이 추가된 직후, 부드럽게 원래 보던 자리로 잡아줌 (사용자는 이질감을 못 느낌)
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
      setStatus("[처리중] 알림망에 접속하고 있습니다...");

      if (!("serviceWorker" in navigator)) { setStatus("[오류] 지원하지 않는 브라우저입니다."); return null; }
      if (!("PushManager" in window)) { setStatus("[오류] 웹 푸시 API가 차단되었습니다."); return null; }
      if (!("Notification" in window)) { setStatus("[오류] 알림 권한 시스템이 없습니다."); return null; }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setStatus("[거부됨] 알림 권한을 허용해주세요."); return null; }

      const registration = await registerServiceWorker();
      const existingSubscription = await registration.pushManager.getSubscription();

      if (existingSubscription) {
        const subscriptionId = await saveSubscription(existingSubscription);
        setStatus("[안내] 이미 알림망에 연결되어 있습니다.");
        return subscriptionId;
      }

      const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!publicKey) { setStatus("[오류] 인증 키가 누락되었습니다."); return null; }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const subscriptionId = await saveSubscription(subscription);
      setStatus("[성공] 새 공지 알림이 활성화되었습니다!");
      return subscriptionId;
    } catch (error) {
      console.error(error);
      setStatus(`[오류] 알림 등록 실패: ${error.message}`);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function testPush() {
    try {
      setLoading(true);
      setStatus("[처리중] 테스트 패킷을 전송합니다...");

      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatus("[오류] 필수 환경이 지원되지 않습니다."); return;
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
        setStatus("[경고] 먼저 [알림 구독]을 완료해주세요."); return;
      }

      await addDoc(collection(db, "push_test_requests"), {
        status: "pending",
        subscriptionId,
        createdAt: serverTimestamp(),
        userAgent: navigator.userAgent,
      });

      setStatus("[성공] 테스트 알림이 발송되었습니다!");
    } catch (error) {
      console.error(error);
      setStatus(`[오류] 테스트 발송 실패: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      {/* 둥둥 떠다니는 장식들 */}
      <div className="bg-deco bg-deco-1 interactive-float">SYS_RDY</div>
      <div className="bg-deco bg-deco-2 interactive-float">NET: OK</div>
      
      {/* 터미널 1: 제어부 */}
      <section className="terminal-window window-animate">
        <div className="terminal-header">
          <div className="header-title">
            <span className="icon-pulse">🔴</span> root@swu: ~/설정
          </div>
          {/* 다크/라이트 모드 토글 */}
          <button className="theme-toggle-btn bounce-hover" onClick={toggleTheme}>
            {theme === "light" ? "모드: ☀️ LIGHT" : "모드: 🌙 DARK"}
          </button>
        </div>
        
        <div className="terminal-body">
          {/* 불필요한 텍스트 제거하고 큼직하게 중앙 정렬 */}
          <div className="sys-info-center">
            <pre className="ascii-art interactive-hover">
{`   _____ _       ____  __
  / ___/| |     / / / / /
  \\__ \\ | | /| / / / / / 
 ___/ / | |/ |/ / /_/ /  
/____/  |__/|__/\\____/`}
            </pre>
          </div>
          
          <div className="command-line">
            <div className="btn-group">
              <button className="cmd-btn primary-btn float-hover" onClick={subscribePush} disabled={loading}>
                {loading ? "처리중..." : "실행: ./새_공지_알림받기"}
              </button>
              <button className="cmd-btn float-hover" onClick={testPush} disabled={loading}>
                {loading ? "처리중..." : "실행: ./알림_테스트"}
              </button>
            </div>
            
            <div className="status-log">
              <span className="cursor blink">█</span> <span className="log-msg">{status}</span>
            </div>
          </div>
        </div>
      </section>

      {/* 터미널 2: 데이터 리스트 */}
      <section className="terminal-window window-animate delay-1">
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
                        {React.createElement(
                          "a",
                          {
                            href: notice.url,
                            target: "_blank",
                            rel: "noreferrer",
                            className: "node-title-link wobbly-hover"
                          },
                          notice.title
                        )}
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
                  <button className="cmd-btn load-more float-hover" onClick={handleLoadMore} disabled={noticeLoading}>
                    {noticeLoading ? "로딩중..." : "명령: ./과거_기록_더보기"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}