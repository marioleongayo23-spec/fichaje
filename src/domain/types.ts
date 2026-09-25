export type Role = 'OWNER' | 'ADMIN' | 'EMPLOYEE';
export type ClockState = 'OUT' | 'WORKING' | 'PAUSED';
export type TimeAction = 'CLOCK_IN' | 'BREAK_START' | 'BREAK_END' | 'CLOCK_OUT';
export type EventSource = 'WEB' | 'KIOSK' | 'CORRECTION';

export interface Organization { id: string; name: string; status: string }
export interface Membership {
  id: string; organization_id: string; auth_user_id: string; role: Role; active: boolean; version: number; created_at: string;
}
export interface Employee {
  id: string; organization_id: string; code: string; display_name: string;
  membership_id: string | null; active: boolean; version: number; created_at: string;
}
export interface EmployeeState {
  state: ClockState; version: number; last_sequence: number; last_event_at: string | null;
  open_session_id: string | null; incident: 'OPEN_SESSION' | null;
}
// Receipt returned by record_time_event after COMMIT (the ACK).
export interface ClockReceipt {
  event_id: string; session_id: string; server_at: string; state: ClockState; version: number; sequence: number; request_id: string;
}
export interface TimelineItem {
  event_id: string | null; adjustment_id: string | null; session_id: string; event_type: TimeAction;
  server_at: string | null; effective_at: string; ordinal: number; source: EventSource; actor_membership_id: string | null;
}
export interface WorkPolicy {
  id: string; organization_id: string; version: number; timezone: string; break_counts_as_work: boolean; valid_from: string; created_at: string;
}
export interface PolicyAssignment { id: string; employee_id: string; policy_id: string; effective_from: string; created_at: string }
export interface WorkSession { id: string; employee_id: string; policy_id: string; timezone: string; created_at: string }
export interface CorrectionRequest {
  id: string; employee_id: string; submitted_by_membership_id: string; affected_membership_id: string | null;
  base_version: number; reason: string; proposal: CorrectionOperation[]; created_at: string;
}
export interface CorrectionDecision {
  id: string; request_id: string; employee_id: string; decision: 'APPROVE' | 'REJECT'; actor_membership_id: string; reason: string; created_at: string;
}
export interface CorrectionOperation {
  operation: 'ADD' | 'REPLACE' | 'VOID'; target_event_id?: string | null; supersedes_adjustment_id?: string | null;
  session_id: string; event_type?: TimeAction; effective_at?: string; timezone?: string; ordinal?: number;
}
export interface HourClassification {
  id: string; employee_id: string; local_month: string; previous_id: string | null; regular_seconds: number;
  complementary_seconds: number; overtime_seconds: number; basis_version: number; reason: string; actor_membership_id: string; created_at: string;
}
