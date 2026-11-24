import { expect, it } from "vitest";
import { readEnrollmentHeaderV1 } from "./enrollment-header-v1.js";

it("reads only the current enrollment header", () => {
  expect(readEnrollmentHeaderV1(new Headers())).toEqual({ kind: "absent" });
  expect(
    readEnrollmentHeaderV1(new Headers({ "X-BB-Enrollment": "bbde_fixture" })),
  ).toEqual({ kind: "absent" });

  for (const credential of ["omnyode_fixture", "bbde_fixture"]) {
    expect(
      readEnrollmentHeaderV1(new Headers({ "X-Omnyo-Enrollment": credential })),
    ).toEqual({ kind: "credential", credential });
  }
});

it("refuses empty or repeated headers before authentication", () => {
  const invalid = [new Headers({ "X-Omnyo-Enrollment": "" })];
  const duplicate = new Headers();

  duplicate.append("X-Omnyo-Enrollment", "omnyode_first");
  duplicate.append("X-Omnyo-Enrollment", "omnyode_second");
  invalid.push(duplicate);

  for (const headers of invalid) {
    expect(readEnrollmentHeaderV1(headers)).toEqual({ kind: "invalid" });
  }
});
