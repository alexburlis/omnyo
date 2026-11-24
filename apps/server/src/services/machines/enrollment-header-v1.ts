type EnrollmentHeader =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "credential"; credential: string };

export function readEnrollmentHeaderV1(headers: Headers): EnrollmentHeader {
  const credential = headers.get("X-Omnyo-Enrollment");

  if (credential === null) return { kind: "absent" };

  if (!/^[A-Za-z0-9_-]+$/u.test(credential)) return { kind: "invalid" };

  return { kind: "credential", credential };
}
