ALTER TABLE "employees"
ADD COLUMN "punchOutNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "push_tokens" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");
CREATE INDEX "push_tokens_employeeId_idx" ON "push_tokens"("employeeId");

ALTER TABLE "push_tokens"
ADD CONSTRAINT "push_tokens_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
