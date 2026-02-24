import { ActionFunction, json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { migrateAllCompanyMetafields } from "~/services/metafieldMigration.server";

/**
 * Admin route to migrate company metafield keys from old naming to new naming
 * POST /app/migrate-metafields
 */
export const action: ActionFunction = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);

    if (request.method === "POST") {
      console.log("🚀 Starting metafield migration process...");

      const migrationResult = await migrateAllCompanyMetafields();

      return json({
        success: migrationResult.success,
        message: migrationResult.success
          ? `Migration completed successfully! Migrated ${migrationResult.totalMigratedFields} metafields across ${migrationResult.successfulCompanies} companies.`
          : "Migration failed",
        ...migrationResult,
      });
    }

    return json({ error: "Method not allowed" }, { status: 405 });
  } catch (error) {
    console.error("Error in metafield migration route:", error);
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
};

// Simple component to trigger migration (for testing)
export default function MigrateMetafields() {
  return (
    <div style={{ padding: "20px" }}>
      <h1>Metafield Migration</h1>
      <p>This route is used to migrate company metafields from old keys to new keys.</p>
      <p><strong>Old keys:</strong> credit_limit, credit_used</p>
      <p><strong>New keys:</strong> company_credit_limit, company_credit_used</p>

      <form method="post">
        <button
          type="submit"
          style={{
            padding: "10px 20px",
            backgroundColor: "#007bff",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer"
          }}
        >
          Start Migration
        </button>
      </form>
    </div>
  );
}
