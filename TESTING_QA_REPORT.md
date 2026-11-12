# Software Engineering Project – Testing & QA Report

## Tester Contribution

Role: Software Tester / Quality Assurance

This report documents the backend testing, database integration testing, authentication checks, and quality assurance work performed for the project.

## 1. Automated Test Execution

| Test Suite | Tests Passed | Failed |
|---|---:|---:|
| npm test | 127 | 0 |
| npm run test:db | 93 | 0 |
| Total test executions | 220 | 0 |

Both test suites completed successfully.

## 2. Testing Areas Covered

- User authentication and authorization
- Password hashing and credential security
- Session creation, validation, and revocation
- Login and logout functionality
- Message validation and persistence
- Message delivery and idempotency
- Group chat and room authorization
- User presence
- User profiles
- User search
- HTTP and WebSocket error handling
- Transport security
- Database integration and migrations

## 3. Manual Testing

The following authentication scenarios were manually checked:

| Scenario | Expected Result | Actual Result |
|---|---|---|
| Register with valid details | Account created successfully | PASS |
| Login with valid credentials | Authentication token returned | PASS |
| Login with incorrect password | HTTP 401 response | PASS |
| Logout with valid token | Session terminated | PASS |
| Reuse revoked token | HTTP 401 response | PASS |

## 4. Test Case Register

The following test case IDs were included in the project QA test plan:

| Test Case ID | Test Area |
|---|---|
| TC-AUTH-01 | Application login |
| TC-AUTH-02 | Database verification |
| TC-CONN-01 | API / server connection |
| TC-PRES-01 | User presence |
| TC-SEARCH-01 | User search |
| TC-MSG-01 | Real-time messaging |
| TC-MSG-02 | Message delivery |
| TC-GRP-01 | Group chat |
| TC-GRP-02 | Group authorization |
| TC-MSG-03 | Message operations |
| TC-HIST-01 | Conversation history |
| TC-NOTIF-01 | Unread message indicator |
| TC-VAL-01 | Message validation |
| TC-REL-01 | Reconnection |
| TC-ERR-01 | Error handling |
| TC-PROF-01 | Profile management |

Note: TC-NOTIF-01 requires separate verification of the unread-message indicator. The 220 passing automated test executions do not independently establish that this feature passed.

## 5. Overall Testing Summary

- 127 automated backend test executions passed.
- 93 database integration test executions passed.
- No failures were reported in either completed suite.
- Manual authentication and session-revocation checks passed.
- Unread-message indicator verification remains pending.

## 6. Tester Contribution

The QA contribution involved executing backend unit and integration test suites, validating authentication and session behavior, checking database-backed functionality, reviewing test outcomes, and documenting test coverage and pending verification.

The testing results help establish the reliability and correctness of the implemented backend functionality.
