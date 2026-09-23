-- the source table's columns as a bridge last saw them: the baseline that a
-- later look at the table is compared with
ALTER TABLE "bridges" ADD COLUMN "source_columns_json" TEXT;
ALTER TABLE "bridges" ADD COLUMN "source_columns_at" TIMESTAMP(3);
