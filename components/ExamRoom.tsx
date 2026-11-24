// src/components/ExamRoom.tsx

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Room, Exam, StudentInfo, Submission, Question, QuestionOption } from '../types';
import {
  auth,
  getExam,
  getRoom,
  createSubmission,
  submitExam,
  subscribeToRoom,
  ensureSignedIn
} from '../services/firebaseService';
import { getTabDetectionService } from '../services/tabDetectionService';
import MathText from './MathText';
import LiveLeaderboard from './LiveLeaderboard';

/**
 * ExamRoom - Phòng thi Toán với MathJax + Hình ảnh + Chống gian lận
 */

// ─── Seeded shuffle (Fisher-Yates với seed đơn giản) ─────────────────────────
// Dùng seed để mỗi học sinh có thứ tự riêng nhưng ổn định trong cả buổi thi.
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  const rand = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Tạo seed từ chuỗi (student.id + room.id + submissionId)
function strToSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

interface ExamRoomProps {
  room: Room;
  student: StudentInfo;
  existingSubmissionId?: string;
  onSubmitted: (submission: Submission) => void;
  onExit: () => void;
}

const ExamRoom: React.FC<ExamRoomProps> = ({ room, student, existingSubmissionId, onSubmitted, onExit }) => {
  const [exam, setExam] = useState<Exam | null>(null);
  const [submissionId, setSubmissionId] = useState<string | null>(existingSubmissionId || null);
  const [userAnswers, setUserAnswers] = useState<{ [key: number]: string }>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirmSubmit, setShowConfirmSubmit] = useState(false);

  const [roomStatus, setRoomStatus] = useState(room.status);
  const [roomLive, setRoomLive] = useState<Room>(room);

  // ✅ Anti-cheat
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [tabSwitchWarnings, setTabSwitchWarnings] = useState<Date[]>([]);
  const [showTabWarning, setShowTabWarning] = useState(false);

  // ✅ Timer (ưu tiên closesAt nếu có)
  const [timeLeft, setTimeLeft] = useState(() => {
    if (room.closesAt) {
      return Math.max(0, Math.floor((room.closesAt.getTime() - Date.now()) / 1000));
    }
    return room.timeLimit * 60;
  });

  // ======= derived schedule flags =======
  const nowMs = Date.now();
  const opensAtMs = roomLive.opensAt ? roomLive.opensAt.getTime() : null;
  const closesAtMs = roomLive.closesAt ? roomLive.closesAt.getTime() : null;

  const notOpenedYet = opensAtMs != null && nowMs < opensAtMs;
  const alreadyClosedBySchedule = closesAtMs != null && nowMs >= closesAtMs;

  const inScheduleWindow =
    (opensAtMs == null || nowMs >= opensAtMs) &&
    (closesAtMs == null || nowMs < closesAtMs);

  // Load exam
  useEffect(() => {
    const loadExam = async () => {
      try {
        await ensureSignedIn();

        const uid = auth.currentUser?.uid;
        if (!uid) throw new Error('Auth missing (anonymous/google)');

        const latestRoom = await getRoom(room.id);
        if (latestRoom) {
          setRoomLive(latestRoom);
          setRoomStatus(latestRoom.status);

          if (latestRoom.closesAt) {
            const s = Math.max(0, Math.floor((latestRoom.closesAt.getTime() - Date.now()) / 1000));
            setTimeLeft(s);
          }
        }

        const examData = await getExam(room.examId);
        if (examData) {
          setExam(examData);

          const fixedStudent: StudentInfo = {
            ...student,
            id: uid
          };

          const r = latestRoom ?? roomLive;
          const rOpens = r.opensAt ? r.opensAt.getTime() : null;
          const rCloses = r.closesAt ? r.closesAt.getTime() : null;
          const rNow = Date.now();

          const rNotOpen = rOpens != null && rNow < rOpens;
          const rClosedSchedule = rCloses != null && rNow >= rCloses;

          const rInWindow = (rOpens == null || rNow >= rOpens) && (rCloses == null || rNow < rCloses);

          if (!submissionId) {
            if (r.status === 'closed' || rNotOpen || rClosedSchedule || !rInWindow) {
              // chưa cho tạo submission
            } else {
              const newId = await createSubmission({
                roomId: room.id,
                roomCode: room.code,
                examId: room.examId,
                student: fixedStudent,
                answers: {},
                score: 0,
                correctCount: 0,
                wrongCount: 0,
                totalQuestions: examData.questions.length,
                percentage: 0,
                startedAt: new Date(),
                submittedAt: null as any,
                duration: 0,
                status: 'in_progress',
                scoreBreakdown: {
                  multipleChoice: { total: 0, correct: 0, points: 0 },
                  trueFalse: { total: 0, correct: 0, partial: 0, points: 0, details: {} },
                  shortAnswer: { total: 0, correct: 0, points: 0 },
                  totalScore: 0,
                  percentage: 0
                },
                totalScore: 0,
                tabSwitchCount: 0,
                tabSwitchWarnings: [],
                autoSubmitted: false
              });

              setSubmissionId(newId);
            }
          }
        }
      } catch (err) {
        console.error('Load exam error:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadExam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.examId]);

  // ✅ Tab Detection Service
  useEffect(() => {
    const tabService = getTabDetectionService();

    tabService.start({
      onTabSwitch: (count: number, warnings: Date[]) => {
        setTabSwitchCount(count);
        setTabSwitchWarnings(warnings);
        setShowTabWarning(true);

        setTimeout(() => setShowTabWarning(false), 5000);
      },
      onAutoSubmit: () => {
        handleSubmit(true, true);
      }
    });

    return () => {
      tabService.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe room status
  useEffect(() => {
    const unsub = subscribeToRoom(room.id, (r: Room | null) => {
      if (r) {
        setRoomLive(r);
        setRoomStatus(r.status);

        if (r.closesAt) {
          const s = Math.max(0, Math.floor((r.closesAt.getTime() - Date.now()) / 1000));
          setTimeLeft(s);
        }

        if (r.status === 'closed') handleSubmit(true, true);
      }
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  // Timer (ưu tiên closesAt)
  useEffect(() => {
    const t = setInterval(() => {
      if (roomLive.closesAt) {
        const s = Math.max(0, Math.floor((roomLive.closesAt.getTime() - Date.now()) / 1000));
        if (s <= 0) {
          handleSubmit(true, true);
          setTimeLeft(0);
        } else {
          setTimeLeft(s);
        }
        return;
      }

      setTimeLeft((p) => {
        if (p <= 1) {
          handleSubmit(true, true);
          return 0;
        }
        return p - 1;
      });
    }, 1000);

    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomLive.closesAt?.getTime(), submissionId, exam]);

  const examStartRef = useRef<number>(Date.now());

  const examTimeLimit = roomLive.timeLimit * 60;
  const [examTimeLeft, setExamTimeLeft] = useState<number>(() =>
    Math.max(0, examTimeLimit - Math.floor((Date.now() - examStartRef.current) / 1000))
  );

  useEffect(() => {
    const t = setInterval(() => {
      const elapsed = Math.floor((Date.now() - examStartRef.current) / 1000);
      const left = Math.max(0, examTimeLimit - elapsed);
      setExamTimeLeft(left);
      if (left <= 0) {
        clearInterval(t);
        handleSubmit(true, true);
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examTimeLimit]);

  const formatMMSS = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const formatTimeHuman = (s: number): { line1: string; line2?: string } => {
    if (s <= 0) return { line1: '0:00' };

    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;

    if (days >= 1) {
      return {
        line1: `${days} ngày ${hours}h`,
        line2: `${mins}p ${secs.toString().padStart(2, '0')}s`
      };
    }
    if (hours >= 1) {
      return {
        line1: `${hours}h ${mins.toString().padStart(2, '0')}m`,
        line2: `${secs.toString().padStart(2, '0')}s`
      };
    }
    return { line1: `${mins}:${secs.toString().padStart(2, '0')}` };
  };

  const hasSchedule = !!roomLive.closesAt;
  const closingFar = hasSchedule && timeLeft > examTimeLimit;

  const handleAnswerChange = (qNum: number, ans: string) => {
    setUserAnswers((prev) => ({ ...prev, [qNum]: ans }));
  };

  const handleSubmit = async (force = false, auto = false) => {
    if (!force && !showConfirmSubmit) {
      setShowConfirmSubmit(true);
      return;
    }
    if (!exam || !submissionId) return;

    setIsSubmitting(true);
    setShowConfirmSubmit(false);

    try {
      await ensureSignedIn();

      const uid = auth.currentUser?.uid;
      if (!uid) throw new Error('Auth missing on submit');

      const result = await submitExam(submissionId, userAnswers, exam, {
        tabSwitchCount,
        tabSwitchWarnings,
        autoSubmitted: auto
      });

      onSubmitted(result);
    } catch (err: any) {
      console.error('Submit error:', err);

      const code = err?.code || err?.name || 'unknown';
      const msg = err?.message || String(err);

      alert(`Lỗi nộp bài!\n\n[${code}]\n${msg}`);

      try {
        await navigator.clipboard.writeText(`[${code}] ${msg}`);
      } catch {}
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── Seed cố định cho cả buổi thi (dựa vào student + room + submission) ───
  const shuffleSeed = useMemo(
    () => strToSeed(`${student.id}|${room.id}|${submissionId ?? 'init'}`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [student.id, room.id, submissionId]
  );

  // Gom nhóm câu hỏi theo PHẦN + xáo trộn thứ tự câu trong mỗi phần
  const groupedQuestions = useMemo(() => {
    if (!exam?.questions) return [];

    const groups: { part: number; title: string; desc: string; questions: Question[] }[] = [];
    const partMap = new Map<number, Question[]>();

    for (const q of exam.questions) {
      const part = Math.floor(q.number / 100) || 1;
      if (!partMap.has(part)) partMap.set(part, []);
      partMap.get(part)!.push(q);
    }

    for (const [part, qs] of Array.from(partMap.entries()).sort((a, b) => a[0] - b[0])) {
      // ✅ Xáo trộn thứ tự câu hỏi trong phần (seed = shuffleSeed + part để mỗi phần khác nhau)
      const shuffled = seededShuffle(qs, shuffleSeed + part * 1000);

      const titles: { [k: number]: [string, string] } = {
        1: ['PHẦN 1. TRẮC NGHIỆM NHIỀU LỰA CHỌN', 'Chọn một phương án đúng A, B, C hoặc D'],
        2: ['PHẦN 2. TRẮC NGHIỆM ĐÚNG SAI', 'Chọn Đúng hoặc Sai cho mỗi mệnh đề'],
        3: ['PHẦN 3. TRẢ LỜI NGẮN', 'Điền đáp án số vào ô trống']
      };
      const [title, desc] = titles[part] || [`PHẦN ${part}`, ''];
      groups.push({ part, title, desc, questions: shuffled });
    }
    return groups;
  }, [exam, shuffleSeed]);

  const answeredCount = Object.keys(userAnswers).filter((k) => userAnswers[+k]).length;
  const totalQuestions = exam?.questions.length || 0;
  const progress = totalQuestions > 0 ? (answeredCount / totalQuestions) * 100 : 0;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
        <div className="bg-white rounded-2xl shadow-2xl p-10 flex flex-col items-center gap-4">
          <div className="relative w-16 h-16">
            <div className="absolute inset-0 rounded-full border-4 border-teal-100"></div>
            <div className="absolute inset-0 rounded-full border-4 border-teal-500 border-t-transparent animate-spin"></div>
          </div>
          <p className="text-gray-600 font-medium">Đang tải đề thi...</p>
        </div>
      </div>
    );
  }

  // ✅ trước giờ mở
  if (notOpenedYet) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
        <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center">
          <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4 text-4xl">⏳</div>
          <h3 className="text-xl font-bold text-gray-800">Phòng thi chưa mở</h3>
          <p className="text-gray-500 mt-2 text-sm">
            Sẽ mở lúc: <span className="font-semibold text-gray-700">{roomLive.opensAt?.toLocaleString()}</span>
          </p>
          <button onClick={onExit} className="mt-6 px-8 py-3 rounded-full bg-gradient-to-r from-teal-500 to-teal-600 text-white font-semibold shadow-lg shadow-teal-200 hover:-translate-y-0.5 transition-transform">
            Quay lại
          </button>
        </div>
      </div>
    );
  }

  // ✅ quá giờ đóng
  if (alreadyClosedBySchedule && roomStatus !== 'closed') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
        <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center">
          <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4 text-4xl">⛔</div>
          <h3 className="text-xl font-bold text-gray-800">Phòng thi đã hết giờ</h3>
          <p className="text-gray-500 mt-2 text-sm">
            Đã đóng lúc: <span className="font-semibold text-gray-700">{roomLive.closesAt?.toLocaleString()}</span>
          </p>
          <button onClick={onExit} className="mt-6 px-8 py-3 rounded-full bg-gradient-to-r from-teal-500 to-teal-600 text-white font-semibold shadow-lg shadow-teal-200 hover:-translate-y-0.5 transition-transform">
            Quay lại
          </button>
        </div>
      </div>
    );
  }

  if (!exam) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
        <div className="bg-white rounded-2xl shadow-2xl p-10 text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">❌</div>
          <p className="text-red-600 font-medium">Không tìm thấy đề thi</p>
          <button onClick={onExit} className="mt-4 text-teal-600 underline text-sm hover:text-teal-800 transition-colors">
            Quay lại
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>

      {/* ─── Sticky Header ─── */}
      <div className="sticky top-0 z-50 shadow-xl" style={{ background: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' }}>
        <div className="max-w-4xl mx-auto px-4 py-3">

          {/* Row 1: Student info + Timer */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-lg font-bold text-white">
                {student.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="font-bold text-white leading-tight">{student.name}</p>
                <p className="text-xs text-teal-100">
                  {student.className && `Lớp ${student.className} · `}Mã: <span className="font-mono font-semibold">{room.code}</span>
                </p>
              </div>
            </div>

            {/* Timer */}
            {closingFar ? (
              <div className="flex flex-col items-end gap-1.5">
                <div className="px-3 py-1.5 rounded-xl bg-white/15 text-center min-w-[110px]">
                  <div className="text-[10px] text-teal-100 leading-none mb-0.5">📅 Đóng phòng sau</div>
                  <div className="font-mono font-bold text-sm text-white leading-tight">
                    {formatTimeHuman(timeLeft).line1}
                  </div>
                  {formatTimeHuman(timeLeft).line2 && (
                    <div className="font-mono text-xs text-teal-100">{formatTimeHuman(timeLeft).line2}</div>
                  )}
                </div>
                <div className={`px-3 py-1.5 rounded-xl text-center min-w-[110px] ${examTimeLeft < 60 ? 'bg-red-500 animate-pulse' : 'bg-amber-500/90'}`}>
                  <div className="text-[10px] text-white/80 leading-none mb-0.5">⏱ Bài thi còn</div>
                  <div className="text-2xl font-mono font-bold text-white leading-tight">{formatMMSS(examTimeLeft)}</div>
                </div>
              </div>
            ) : (
              <div className={`px-4 py-2 rounded-xl text-center min-w-[100px] ${timeLeft < 60 ? 'bg-red-500 animate-pulse' : 'bg-white/15'}`}>
                <div className="text-[10px] text-teal-100 leading-none mb-0.5">⏱ Còn lại</div>
                {(() => {
                  const fmt = formatTimeHuman(timeLeft);
                  return (
                    <>
                      <div className="text-2xl font-mono font-bold text-white leading-tight">{fmt.line1}</div>
                      {fmt.line2 && <div className="text-xs font-mono text-teal-100">{fmt.line2}</div>}
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Row 2: Progress + Submit btn */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="flex justify-between text-xs text-teal-100 mb-1">
                <span className="font-medium">✍️ {answeredCount}/{totalQuestions} câu</span>
                <span className="font-bold text-white">{Math.round(progress)}%{progress === 100 && ' 🔥'}</span>
              </div>
              <div className="h-2.5 bg-white/20 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${progress}%`,
                    background: progress === 100
                      ? 'linear-gradient(90deg,#4ade80,#22c55e)'
                      : progress >= 70
                      ? 'linear-gradient(90deg,#fbbf24,#f59e0b)'
                      : 'linear-gradient(90deg,#38bdf8,#818cf8)',
                    boxShadow: progress === 100 ? '0 0 8px rgba(74,222,128,0.7)' : undefined,
                  }}
                />
              </div>
            </div>

            <button
              onClick={() => setShowConfirmSubmit(true)}
              disabled={isSubmitting || !submissionId}
              className={`flex items-center gap-2 px-5 py-2 rounded-full font-bold text-sm transition-all duration-200 ${
                isSubmitting || !submissionId
                  ? 'bg-white/20 text-white/50 cursor-not-allowed'
                  : 'bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg shadow-orange-900/30 hover:-translate-y-0.5 hover:shadow-xl'
              }`}
            >
              <span>📤</span>
              <span>Nộp bài</span>
            </button>
          </div>
        </div>
      </div>

      {/* ─── Alerts ─── */}
      {showTabWarning && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-50 animate-bounce">
          <div className="bg-red-500 text-white px-6 py-3 rounded-xl shadow-2xl font-bold text-sm">
            ⚠️ CẢNH BÁO: Phát hiện chuyển tab! ({tabSwitchCount}/2)
            {tabSwitchCount === 1 && <p className="text-xs mt-0.5 font-normal opacity-90">Lần tiếp theo sẽ tự động nộp bài!</p>}
          </div>
        </div>
      )}

      {roomStatus === 'closed' && (
        <div className="bg-red-500 text-white text-center py-2 text-sm font-bold">
          ⚠️ Phòng thi đã đóng! Đang nộp bài tự động...
        </div>
      )}

      {!submissionId && (
        <div className="bg-amber-500 text-white text-center py-2 text-sm font-semibold">
          ⚠️ Chưa tạo được bài làm (phòng chưa tới giờ hoặc lỗi rules). Vui lòng tải lại khi đến giờ.
        </div>
      )}

      {/* ─── Main Content ─── */}
      <div className="max-w-4xl mx-auto px-4 py-6">

        {/* Exam title card */}
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden mb-6">
          <div className="px-6 py-5 text-center" style={{ background: 'linear-gradient(135deg, #14b8a6 0%, #0f766e 100%)' }}>
            <h1 className="text-xl font-bold text-white">{exam.title}</h1>
            <p className="text-teal-100 text-sm mt-1">Tổng: {totalQuestions} câu hỏi</p>
          </div>
        </div>

        {/* Question Groups */}
        <div className="space-y-8">
          {groupedQuestions.map((group) => (
            <div key={group.part}>

              {/* Part header */}
              <div className={`rounded-2xl p-4 mb-4 shadow-lg ${
                group.part === 1
                  ? 'bg-gradient-to-r from-blue-500 to-blue-600'
                  : group.part === 2
                  ? 'bg-gradient-to-r from-emerald-500 to-emerald-600'
                  : 'bg-gradient-to-r from-orange-500 to-orange-600'
              }`}>
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center text-2xl flex-shrink-0">
                    {group.part === 1 ? '📝' : group.part === 2 ? '✅' : '✏️'}
                  </div>
                  <div>
                    <h2 className="font-bold text-white text-sm md:text-base">{group.title}</h2>
                    <p className="text-white/80 text-xs mt-0.5">{group.desc}</p>
                  </div>
                  <div className="ml-auto">
                    <span className="bg-white/20 text-white text-xs font-semibold px-3 py-1 rounded-full">
                      {group.questions.length} câu
                    </span>
                  </div>
                </div>
              </div>

              {/* Questions */}
              <div className="space-y-4">
                {group.questions.map((q) => (
                  <QuestionCard
                    key={q.number}
                    question={q}
                    displayNum={q.number % 100}
                    userAnswer={userAnswers[q.number]}
                    onChange={(ans) => handleAnswerChange(q.number, ans)}
                    shuffleSeed={shuffleSeed + q.number}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Bottom submit button */}
        <div className="sticky bottom-0 mt-6 pt-4 pb-6">
          <div className="flex justify-center">
            <button
              onClick={() => setShowConfirmSubmit(true)}
              disabled={isSubmitting || !submissionId}
              className={`flex items-center gap-3 px-12 py-4 rounded-full font-bold text-base transition-all duration-200 shadow-2xl ${
                isSubmitting || !submissionId
                  ? 'bg-white/30 text-white/50 cursor-not-allowed'
                  : 'bg-gradient-to-r from-amber-400 to-orange-500 text-white hover:-translate-y-1 hover:shadow-orange-500/40'
              }`}
            >
              {isSubmitting ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Đang nộp...</span>
                </>
              ) : (
                <>
                  <span className="text-xl">📤</span>
                  <span>Nộp bài</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ─── Live Leaderboard ─── */}
      {submissionId && (
        <LiveLeaderboard
          roomId={room.id}
          studentId={student.id}
          studentName={student.name}
          totalQuestions={totalQuestions}
          answeredCount={answeredCount}
        />
      )}

      {/* ─── Confirm Submit Modal ─── */}
      {showConfirmSubmit && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }}
        >
          <div
            className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl"
            style={{ animation: 'popIn 0.35s cubic-bezier(0.34,1.56,0.64,1)' }}
          >
            <style>{`@keyframes popIn{0%{transform:scale(0.6);opacity:0}70%{transform:scale(1.05)}100%{transform:scale(1);opacity:1}}`}</style>

            <div className="text-center mb-6">
              <div className="w-20 h-20 rounded-full mx-auto mb-4 flex items-center justify-center text-4xl
                            bg-gradient-to-br from-amber-100 to-orange-100">
                {answeredCount === totalQuestions ? '🎯' : '📝'}
              </div>
              <h3 className="text-xl font-bold text-gray-800">Xác nhận nộp bài?</h3>
              <p className="text-gray-500 text-sm mt-2">
                Đã trả lời{' '}
                <strong className="text-teal-600">{answeredCount}/{totalQuestions}</strong> câu
              </p>
              {answeredCount < totalQuestions && (
                <div className="mt-3 px-4 py-2 bg-orange-50 border border-orange-200 rounded-xl">
                  <p className="text-orange-600 text-sm font-medium">
                    ⚠️ Còn <strong>{totalQuestions - answeredCount}</strong> câu chưa làm!
                  </p>
                </div>
              )}
              {answeredCount === totalQuestions && (
                <div className="mt-3 px-4 py-2 bg-green-50 border border-green-200 rounded-xl">
                  <p className="text-green-600 text-sm font-semibold">✅ Đã hoàn thành tất cả câu!</p>
                </div>
              )}
              <p className="text-xs text-gray-400 mt-3 bg-gray-50 rounded-xl px-3 py-2">
                🏆 Sau khi nộp bài, bạn sẽ thấy thứ hạng thật trên bảng xếp hạng live!
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirmSubmit(false)}
                className="flex-1 py-3 rounded-xl font-semibold text-gray-600 border-2 border-gray-200 hover:bg-gray-50 transition-colors"
              >
                Tiếp tục làm
              </button>
              <button
                onClick={() => handleSubmit(true)}
                disabled={isSubmitting || !submissionId}
                className={`flex-1 py-3 rounded-xl font-bold text-white transition-all duration-200 ${
                  isSubmitting || !submissionId
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-gradient-to-r from-amber-400 to-orange-500 hover:-translate-y-0.5 shadow-lg shadow-orange-200'
                }`}
              >
                {isSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Đang nộp...
                  </span>
                ) : '🚀 Nộp & Xem hạng!'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExamRoom;


// ============================================================
//  QUESTION CARD
// ============================================================

interface ImageData {
  id?: string;
  base64?: string;
  contentType?: string;
  rId?: string;
}

interface QuestionCardProps {
  question: Question;
  displayNum: number;
  userAnswer?: string;
  onChange: (ans: string) => void;
  shuffleSeed?: number;
}

const QuestionCard: React.FC<QuestionCardProps> = ({ question, displayNum, userAnswer, onChange, shuffleSeed = 0 }) => {
  const qType = question.type || 'multiple_choice';
  const isAnswered = !!userAnswer;

  const questionImages: ImageData[] = (question as any).images || [];

  const imageUrls = useMemo(() => {
    return questionImages
      .map((img) => {
        if (img.base64) {
          const contentType = img.contentType || 'image/png';
          return img.base64.startsWith('data:') ? img.base64 : `data:${contentType};base64,${img.base64}`;
        }
        return null;
      })
      .filter(Boolean) as string[];
  }, [questionImages]);

  // ✅ Xáo trộn VỊ TRÍ HIỂN THỊ — GIỮ NGUYÊN nhãn gốc (A/B/C/D hoặc a/b/c/d)
  // KHÔNG đổi lại nhãn vì correctAnswer trong Firestore dùng nhãn gốc để chấm điểm.
  const shuffledOptions = useMemo<QuestionOption[]>(() => {
    if (!question.options || question.options.length === 0) return question.options || [];

    if (qType === 'multiple_choice') {
      // Chỉ xáo trộn thứ tự hiển thị, KHÔNG đổi letter
      // Học sinh chọn "C" → lưu "C" → scoring so với correctAnswer="C" ✓
      return seededShuffle(question.options, shuffleSeed);
    }

    if (qType === 'true_false') {
      // Xáo trộn a, b, c — d cố định cuối. KHÔNG đổi letter
      // Học sinh check "a" → lưu "a" → scoring so với correctAnswer="a,c" ✓
      const dOpt = question.options.find((o) => o.letter.toLowerCase() === 'd');
      const movable = question.options.filter((o) => o.letter.toLowerCase() !== 'd');
      const shuffled = seededShuffle(movable, shuffleSeed);
      return dOpt ? [...shuffled, dOpt] : shuffled;
    }

    return question.options;
  }, [question.options, qType, shuffleSeed]);

  // Question type metadata
  const typeInfo = {
    multiple_choice: { label: 'Trắc nghiệm', icon: '📝', color: 'bg-blue-100 text-blue-700' },
    true_false:      { label: 'Đúng / Sai',  icon: '✅', color: 'bg-emerald-100 text-emerald-700' },
    short_answer:    { label: 'Tự luận',      icon: '✏️', color: 'bg-orange-100 text-orange-700' },
    writing:         { label: 'Tự luận',      icon: '✏️', color: 'bg-orange-100 text-orange-700' },
  } as const;
  const meta = typeInfo[qType as keyof typeof typeInfo] ?? typeInfo.multiple_choice;

  return (
    <div
      className={`bg-white rounded-2xl border-2 overflow-hidden transition-all duration-300 group ${
        isAnswered
          ? 'border-teal-400 shadow-lg shadow-teal-100/60'
          : 'border-gray-200 hover:border-teal-300 hover:-translate-y-0.5 hover:shadow-xl'
      }`}
    >
      {/* ── Question header ── */}
      <div className="flex items-start gap-4 px-5 py-4 border-b border-gray-100"
           style={{ background: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)' }}>

        {/* Number badge */}
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-white text-sm flex-shrink-0 shadow-md transition-colors duration-300 ${
            isAnswered ? 'bg-teal-500' : 'bg-slate-400 group-hover:bg-teal-400'
          }`}
        >
          {displayNum}
        </div>

        <div className="flex-1 min-w-0">
          {/* Type badge */}
          <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full mb-2 ${meta.color}`}>
            <span>{meta.icon}</span>
            <span>{meta.label}</span>
          </span>

          {/* Question text */}
          <MathText html={question.text} className="text-gray-800 leading-relaxed text-sm md:text-base" block />

          {/* Images */}
          {imageUrls.length > 0 && (
            <div className="mt-3 space-y-2">
              {imageUrls.map((url, idx) => (
                <div key={idx} className="flex justify-center bg-gray-50 rounded-xl p-2">
                  <img
                    src={url}
                    alt={`Hình ${idx + 1} - Câu ${displayNum}`}
                    className="max-w-full h-auto rounded-lg shadow-sm border border-gray-200"
                    style={{ maxHeight: '280px' }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Answer area ── */}
      <div className="px-5 py-4">

        {/* ── MULTIPLE CHOICE ── */}
        {qType === 'multiple_choice' && shuffledOptions.length > 0 && (
          <div className="space-y-2.5">
            {shuffledOptions.map((opt: QuestionOption) => {
              const selected = userAnswer?.toUpperCase() === opt.letter.toUpperCase();
              return (
                <label
                  key={opt.letter}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 cursor-pointer transition-all duration-200 ${
                    selected
                      ? 'border-amber-400 bg-amber-50 shadow-md shadow-amber-100'
                      : 'border-gray-200 bg-gray-50 hover:border-teal-300 hover:bg-teal-50 hover:translate-x-1'
                  }`}
                >
                  <input
                    type="radio"
                    name={`q${question.number}`}
                    value={opt.letter}
                    checked={selected}
                    onChange={(e) => onChange(e.target.value)}
                    className="hidden"
                  />
                  {/* Letter circle */}
                  <span
                    className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 transition-colors duration-200 ${
                      selected ? 'bg-amber-400 text-white shadow-sm' : 'bg-teal-500 text-white'
                    }`}
                  >
                    {opt.letter}
                  </span>
                  <MathText html={opt.text} className="flex-1 text-gray-700 text-sm leading-relaxed" />
                  {/* Checkmark */}
                  {selected && (
                    <span className="text-amber-500 text-lg flex-shrink-0">✓</span>
                  )}
                </label>
              );
            })}
          </div>
        )}

        {/* ── TRUE / FALSE ── */}
        {qType === 'true_false' && shuffledOptions.length > 0 && (
          <div className="space-y-2.5">
            {shuffledOptions.map((opt: QuestionOption) => {
              const selected = (userAnswer?.split(',') || [])
                .map((s) => s.trim().toLowerCase())
                .includes(opt.letter.toLowerCase());

              const toggle = () => {
                const curr = (userAnswer?.split(',') || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
                const next = selected
                  ? curr.filter((l) => l !== opt.letter.toLowerCase())
                  : [...curr, opt.letter.toLowerCase()];
                onChange(next.sort().join(','));
              };

              return (
                <div
                  key={opt.letter}
                  onClick={toggle}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 cursor-pointer transition-all duration-200 ${
                    selected
                      ? 'border-emerald-400 bg-emerald-50 shadow-md shadow-emerald-100'
                      : 'border-gray-200 bg-gray-50 hover:border-emerald-300 hover:bg-emerald-50/50 hover:translate-x-1'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={toggle}
                    className="hidden"
                    onClick={(e) => e.stopPropagation()}
                  />
                  {/* Custom checkbox */}
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors duration-200 ${
                    selected ? 'bg-emerald-500 border-emerald-500' : 'border-gray-300 bg-white'
                  }`}>
                    {selected && <span className="text-white text-xs font-bold">✓</span>}
                  </div>
                  {/* Letter pill */}
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500 text-white flex-shrink-0">
                    {opt.letter})
                  </span>
                  <MathText html={opt.text} className="flex-1 text-gray-700 text-sm leading-relaxed" />
                </div>
              );
            })}
          </div>
        )}

        {/* ── SHORT ANSWER / WRITING ── */}
        {(qType === 'short_answer' || qType === 'writing') && (
          <div className="rounded-xl border-2 border-gray-200 bg-gray-50 p-4"
               style={{ background: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)' }}>
            <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">
              Đáp án của bạn
            </label>
            <input
              type="text"
              value={userAnswer || ''}
              onChange={(e) => onChange(e.target.value)}
              placeholder="Nhập đáp án..."
              className={`w-full px-4 py-3 border-2 rounded-xl text-base font-medium bg-white transition-all duration-200 focus:outline-none ${
                userAnswer
                  ? 'border-teal-400 focus:border-teal-500 focus:shadow-lg focus:shadow-teal-100'
                  : 'border-gray-300 focus:border-teal-400 focus:shadow-lg focus:shadow-teal-100'
              }`}
            />
            <p className="text-xs text-gray-400 mt-2 flex items-center gap-1">
              <span>💡</span>
              <span>Nhập đáp án số (VD: 42 hoặc -3.5)</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
