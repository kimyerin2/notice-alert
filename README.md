# notice-push
각종 공지사항을 수집하고 Discord로 새 공지를 알림 보내는 Python 프로젝트

## 개발 배경
학교/학과/기숙사 홈페이지의 공지사항을 통합적으로 확인하고
중요 공지를 Discord 푸시 알림으로 받는 시스템을 개발한다.

## 1차 목표
- 학과 공지사항 페이지에서 새 공지를 감지한다.
- 새 공지가 있으면 Discord 채널로 알림을 보낸다.
- 신청/마감/졸업/장학/기숙사 등 중요 키워드가 포함되면 멘션 알림을 보낸다.

## 사용 기술
- Python
- requests
- BeautifulSoup
- SQLite
- Discord Webhook

