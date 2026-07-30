import { ActionFunctionArgs, LoaderFunctionArgs, redirect } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import prisma from "app/db.server";
import { createSalesSession, buildSessionCookie } from "app/utils/sales-session.server";
import { useMemo } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const email = url.searchParams.get("email");

  if (!token || !email) {
    return Response.json({ valid: false, message: "The reset link is invalid or has expired." });
  }

  const user = await prisma.user.findFirst({
    where: {
      email,
      role: "SALES_USER",
      passwordResetToken: token,
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      passwordResetExpiresAt: true,
    },
  });

  if (!user?.passwordResetExpiresAt || new Date(user.passwordResetExpiresAt).getTime() < Date.now()) {
    return Response.json({ valid: false, message: "The reset link is invalid or has expired." });
  }

  return Response.json({ valid: true, email: user.email, firstName: user.firstName });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Invalid request method." });
  }

  const formData = await request.formData();
  const password = formData.get("password") as string;
  const token = formData.get("token") as string;
  const email = formData.get("email") as string;

  if (!password || !token || !email) {
    return Response.json({ error: "The reset link is invalid or has expired." });
  }

  if (password.length < 6) {
    return Response.json({ error: "Password must be at least 6 characters." });
  }

  const user = await prisma.user.findFirst({
    where: {
      email,
      role: "SALES_USER",
      passwordResetToken: token,
    },
    select: { id: true, passwordResetExpiresAt: true },
  });

  if (!user?.passwordResetExpiresAt || new Date(user.passwordResetExpiresAt).getTime() < Date.now()) {
    return Response.json({ error: "The reset link is invalid or has expired." });
  }

  const bcrypt = await import("bcryptjs");
  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpiresAt: null,
    },
  });

  const sessionToken = await createSalesSession(user.id);
  return redirect("/sales/portal", {
    headers: {
      "Set-Cookie": buildSessionCookie(sessionToken),
    },
  });
};

export default function SalesResetPassword() {
  const loaderData = useLoaderData<{ valid?: boolean; message?: string; email?: string; firstName?: string | null }>();
  const actionData = useActionData<{ error?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const token = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("token") || "";
  }, []);

  if (!loaderData?.valid) {
    return (
      <div style={styles.pageContainer}>
        <div style={styles.card}>
          <h1 style={styles.heroText}>Reset link expired</h1>
          <p style={styles.bodyText}>{loaderData?.message || "The reset link is invalid or has expired."}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.pageContainer}>
      <div style={styles.card}>
        <div style={styles.header}>
          <h1 style={styles.heroText}>Choose a new password</h1>
          <p style={styles.bodyText}>
            Hi {loaderData.firstName || "there"}, enter a new password for your Sales Portal account.
          </p>
        </div>

        {actionData?.error && (
          <div style={styles.errorAlert}>{actionData.error}</div>
        )}

        <Form method="post" style={styles.form}>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="email" value={loaderData.email || ""} />

          <div style={styles.inputGroup}>
            <label htmlFor="sales-new-password" style={styles.label}>
              New Password
            </label>
            <input
              id="sales-new-password"
              type="password"
              name="password"
              required
              minLength={6}
              autoComplete="new-password"
              style={styles.input}
              placeholder="Enter at least 6 characters"
            />
          </div>

          <button type="submit" style={styles.button} disabled={isSubmitting}>
            {isSubmitting ? "Updating..." : "Reset password"}
          </button>
        </Form>
      </div>
    </div>
  );
}

const styles = {
  pageContainer: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #fdf4f7 0%, #fff7eb 100%)",
    padding: "20px",
    fontFamily: "'Inter', sans-serif",
  },
  card: {
    width: "100%",
    maxWidth: "430px",
    background: "rgba(255,255,255,0.95)",
    borderRadius: "24px",
    padding: "40px",
    boxShadow: "0 20px 40px rgba(0,0,0,0.08)",
  },
  header: {
    marginBottom: "24px",
  },
  heroText: {
    fontSize: "28px",
    fontWeight: 700,
    margin: "0 0 8px",
    color: "#111827",
  },
  bodyText: {
    margin: 0,
    color: "#6b7280",
    lineHeight: 1.6,
  },
  form: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "18px",
  },
  inputGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
  },
  label: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#374151",
  },
  input: {
    padding: "14px 16px",
    borderRadius: "12px",
    border: "1px solid #e5e7eb",
    fontSize: "15px",
    outline: "none",
  },
  button: {
    padding: "14px 20px",
    borderRadius: "14px",
    border: "none",
    background: "linear-gradient(135deg, var(--sales-portal-accent) 0%, var(--sales-portal-accent-dark) 100%)",
    color: "var(--sales-portal-accent-contrast)",
    fontSize: "15px",
    fontWeight: 600,
    cursor: "pointer",
  },
  errorAlert: {
    background: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
    borderRadius: "12px",
    padding: "12px 14px",
    marginBottom: "16px",
    fontSize: "14px",
  },
};
