-- Attendance records captured without a GPS fix (unrestricted employees) store NULL
-- coordinates instead of a fake 0.0, 0.0. Only attendance_records changes; the sites
-- table keeps its coordinates required.
--
-- Non-destructive and backward compatible: existing rows keep their values, and the
-- previous application build (which always writes both columns) keeps working.

-- AlterTable
ALTER TABLE "attendance_records" ALTER COLUMN "latitude" DROP NOT NULL,
ALTER COLUMN "longitude" DROP NOT NULL;
