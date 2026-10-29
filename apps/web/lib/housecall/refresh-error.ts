import { HousecallError } from "@svl/integrations";
import { HttpError } from "@/lib/http";

/** Only allowlisted failures become user-facing refresh guidance. Provider
 * response bodies, database details and arbitrary messages stay private. */
export function housecallRefreshError(error: unknown): HttpError | null {
  if (error instanceof HousecallError) {
    switch (error.code) {
      case "configuration":
      case "authentication":
      case "forbidden":
        return new HttpError(
          503,
          "housecall_connection_unavailable",
          "Housecall access could not be verified. Ask an administrator to check the connection, then refresh jobs again.",
        );
      case "rate_limited":
        return new HttpError(
          429,
          "housecall_rate_limited",
          "Housecall is temporarily limiting requests. Wait a little, then refresh jobs again.",
        );
      case "timeout":
        return new HttpError(
          504,
          "housecall_refresh_timeout",
          "Housecall took too long to respond. Refresh jobs again shortly.",
        );
      case "network":
      case "provider_unavailable":
        return new HttpError(
          503,
          "housecall_temporarily_unavailable",
          "Housecall could not be reached. Refresh jobs again shortly.",
        );
      case "invalid_response":
      case "provider_rejected":
      case "not_found":
        return new HttpError(
          502,
          "housecall_refresh_invalid_response",
          "Housecall did not return a complete job list. Refresh jobs again; contact an administrator if this continues.",
        );
    }
  }
  if (error instanceof Error) {
    if (error.message === "sync_deadline")
      return new HttpError(
        504,
        "housecall_refresh_timeout",
        "The job refresh did not finish in time. Refresh jobs again; contact an administrator if this continues.",
      );
    if (["sync_unstable_pages", "sync_page_limit", "sync_wrong_customer"].includes(error.message))
      return new HttpError(
        502,
        "housecall_refresh_incomplete",
        "The Housecall job list changed or could not be verified completely. Refresh jobs again; contact an administrator if this continues.",
      );
  }
  return null;
}
