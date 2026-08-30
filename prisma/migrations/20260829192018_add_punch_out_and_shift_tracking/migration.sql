-- CreateEnum
CREATE TYPE "PunchType" AS ENUM ('IN', 'OUT');

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "pairedPunchId" TEXT,
ADD COLUMN     "punchType" "PunchType" NOT NULL DEFAULT 'IN',
ADD COLUMN     "shiftDurationMinutes" INTEGER;

-- CreateIndex
CREATE INDEX "attendance_records_punchType_idx" ON "attendance_records"("punchType");

-- CreateIndex
CREATE INDEX "attendance_records_pairedPunchId_idx" ON "attendance_records"("pairedPunchId");
