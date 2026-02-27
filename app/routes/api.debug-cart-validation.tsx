import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import CartValidationDebugService from "../services/cartValidationDebug.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const action = formData.get("action") as string;
  const title = formData.get("title") as string;
  const useExactQuery = formData.get("useExactQuery") === "true";

  console.log(`🔧 Debug action requested: ${action}`);

  try {
    switch (action) {
      case "list_functions":
        return json(await CartValidationDebugService.listAllShopifyFunctions(admin));

      case "debug_all_functions":
        return json(await CartValidationDebugService.debugListAllFunctions(admin));

      case "list_validations":
        return json(await CartValidationDebugService.listAllValidations(admin));

      case "register_original":
        return json(await CartValidationDebugService.testOriginalRegistration(admin, title || undefined));

      case "register_exact":
        return json(await CartValidationDebugService.testExactQueryRegistration(admin, title || undefined));

      case "full_workflow":
        return json(await CartValidationDebugService.setupValidationWorkflow(admin, {
          title: title || undefined,
          useExactQuery
        }));

      case "cleanup":
        return json(await CartValidationDebugService.cleanupCartValidations(admin));

      default:
        return json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("❌ Debug action error:", error);
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
};
