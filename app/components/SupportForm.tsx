import { useFetcher } from "react-router";
import { useState, useEffect, useRef } from "react";

const styles: Record<string, React.CSSProperties> = {
  fab: {
    position: "fixed",
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: "50%",
    backgroundColor: "#007FEF",
    color: "#FFFFFF",
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 14px rgba(0,127,239,0.4)",
    zIndex: 999999,
    transition: "transform 0.2s ease, box-shadow 0.2s ease",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    zIndex: 999998,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  modal: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    width: "90%",
    maxWidth: 440,
    maxHeight: "90vh",
    overflowY: "auto",
    padding: 32,
    position: "relative",
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
  },
  close: {
    position: "absolute",
    top: 16,
    right: 16,
    width: 32,
    height: 32,
    borderRadius: "50%",
    border: "none",
    backgroundColor: "#f3f4f6",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
    color: "#6b7280",
  },
  heading: {
    margin: "0 0 24px",
    fontSize: 22,
    fontWeight: 700,
    color: "#111827",
    fontFamily: "Poppins, sans-serif",
  },
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    display: "block",
    marginBottom: 6,
    fontSize: 14,
    fontWeight: 600,
    color: "#374151",
    fontFamily: "Inter, sans-serif",
  },
  input: {
    width: "100%",
    padding: "10px 14px",
    fontSize: 14,
    border: "1px solid #d1d5db",
    borderRadius: 8,
    outline: "none",
    boxSizing: "border-box",
    fontFamily: "Inter, sans-serif",
    transition: "border-color 0.2s ease",
  },
  textarea: {
    width: "100%",
    padding: "10px 14px",
    fontSize: 14,
    border: "1px solid #d1d5db",
    borderRadius: 8,
    outline: "none",
    resize: "vertical",
    minHeight: 100,
    boxSizing: "border-box",
    fontFamily: "Inter, sans-serif",
    transition: "border-color 0.2s ease",
  },
  submitBtn: {
    width: "100%",
    padding: "12px 24px",
    fontSize: 15,
    fontWeight: 600,
    color: "#FFFFFF",
    backgroundColor: "#007FEF",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontFamily: "Poppins, sans-serif",
    transition: "opacity 0.2s ease",
    marginTop: 8,
  },
  submitBtnDisabled: {
    opacity: 0.6,
    cursor: "not-allowed",
  },
  alert: {
    padding: "10px 14px",
    borderRadius: 8,
    marginBottom: 16,
    fontSize: 14,
    fontFamily: "Inter, sans-serif",
  },
  alertSuccess: {
    backgroundColor: "#ecfdf5",
    color: "#065f46",
    border: "1px solid #a7f3d0",
  },
  alertError: {
    backgroundColor: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
  },
  required: {
    color: "#ef4444",
    marginLeft: 2,
  },
  successContainer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    padding: "24px 0 8px",
    animation: "sfFadeIn 0.3s ease-out",
  },
  successIcon: {
    width: 64,
    height: 64,
    color: "#10b981",
    backgroundColor: "#ecfdf5",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
    boxShadow: "0 4px 12px rgba(16, 185, 129, 0.15)",
  },
  successHeading: {
    fontSize: 20,
    fontWeight: 700,
    color: "#111827",
    marginBottom: 8,
    fontFamily: "Poppins, sans-serif",
  },
  successText: {
    fontSize: 15,
    color: "#4b5563",
    lineHeight: "1.5",
    marginBottom: 28,
    fontFamily: "Inter, sans-serif",
    maxWidth: 320,
  },
  fillAgainBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 600,
    color: "#007FEF",
    backgroundColor: "#FFFFFF",
    border: "2px solid #007FEF",
    borderRadius: 8,
    cursor: "pointer",
    fontFamily: "Poppins, sans-serif",
    transition: "all 0.2s ease",
  },
  countryCodeSelect: {
    width: 100,
    padding: "10px 8px",
    fontSize: 14,
    border: "1px solid #d1d5db",
    borderRadius: 8,
    outline: "none",
    boxSizing: "border-box",
    fontFamily: "Inter, sans-serif",
    backgroundColor: "#FFFFFF",
    cursor: "pointer",
    transition: "border-color 0.2s ease",
  },
};

interface SupportFormData {
  name: string;
  email: string;
  countryCode?: string;
  phone?: string;
  comment: string;
}

const COUNTRIES_LIST = [
  { code: "AF", name: "Afghanistan", dial: "+93", flag: "🇦🇫" },
  { code: "AL", name: "Albania", dial: "+355", flag: "🇦🇱" },
  { code: "DZ", name: "Algeria", dial: "+213", flag: "🇩🇿" },
  { code: "AS", name: "American Samoa", dial: "+1-684", flag: "🇦🇸" },
  { code: "AD", name: "Andorra", dial: "+376", flag: "🇦🇩" },
  { code: "AO", name: "Angola", dial: "+244", flag: "🇦🇴" },
  { code: "AI", name: "Anguilla", dial: "+1-264", flag: "🇦🇮" },
  { code: "AQ", name: "Antarctica", dial: "+672", flag: "🇦🇶" },
  { code: "AG", name: "Antigua and Barbuda", dial: "+1-268", flag: "🇦🇬" },
  { code: "AR", name: "Argentina", dial: "+54", flag: "🇦🇷" },
  { code: "AM", name: "Armenia", dial: "+374", flag: "🇦🇲" },
  { code: "AW", name: "Aruba", dial: "+297", flag: "🇦🇼" },
  { code: "AU", name: "Australia", dial: "+61", flag: "🇦🇺" },
  { code: "AT", name: "Austria", dial: "+43", flag: "🇦🇹" },
  { code: "AZ", name: "Azerbaijan", dial: "+994", flag: "🇦🇿" },
  { code: "BS", name: "Bahamas", dial: "+1-242", flag: "🇧🇸" },
  { code: "BH", name: "Bahrain", dial: "+973", flag: "🇧🇭" },
  { code: "BD", name: "Bangladesh", dial: "+880", flag: "🇧🇩" },
  { code: "BB", name: "Barbados", dial: "+1-246", flag: "🇧🇧" },
  { code: "BY", name: "Belarus", dial: "+375", flag: "🇧🇾" },
  { code: "BE", name: "Belgium", dial: "+32", flag: "🇧🇪" },
  { code: "BZ", name: "Belize", dial: "+501", flag: "🇧🇿" },
  { code: "BJ", name: "Benin", dial: "+229", flag: "🇧🇯" },
  { code: "BM", name: "Bermuda", dial: "+1-441", flag: "🇧🇲" },
  { code: "BT", name: "Bhutan", dial: "+975", flag: "🇧🇹" },
  { code: "BO", name: "Bolivia", dial: "+591", flag: "🇧🇴" },
  { code: "BA", name: "Bosnia and Herzegovina", dial: "+387", flag: "🇧🇦" },
  { code: "BW", name: "Botswana", dial: "+267", flag: "🇧🇼" },
  { code: "BR", name: "Brazil", dial: "+55", flag: "🇧🇷" },
  { code: "IO", name: "British Indian Ocean Territory", dial: "+246", flag: "🇮🇴" },
  { code: "VG", name: "British Virgin Islands", dial: "+1-284", flag: "🇻🇬" },
  { code: "BN", name: "Brunei", dial: "+673", flag: "🇧🇳" },
  { code: "BG", name: "Bulgaria", dial: "+359", flag: "🇧🇬" },
  { code: "BF", name: "Burkina Faso", dial: "+226", flag: "🇧🇫" },
  { code: "BI", name: "Burundi", dial: "+257", flag: "🇧🇮" },
  { code: "KH", name: "Cambodia", dial: "+855", flag: "🇰🇭" },
  { code: "CM", name: "Cameroon", dial: "+237", flag: "🇨🇲" },
  { code: "CA", name: "Canada", dial: "+1", flag: "🇨🇦" },
  { code: "CV", name: "Cape Verde", dial: "+238", flag: "🇨🇻" },
  { code: "KY", name: "Cayman Islands", dial: "+1-345", flag: "🇰🇾" },
  { code: "CF", name: "Central African Republic", dial: "+236", flag: "🇨🇫" },
  { code: "TD", name: "Chad", dial: "+235", flag: "🇹🇩" },
  { code: "CL", name: "Chile", dial: "+56", flag: "🇨🇱" },
  { code: "CN", name: "China", dial: "+86", flag: "🇨🇳" },
  { code: "CX", name: "Christmas Island", dial: "+61", flag: "🇨🇽" },
  { code: "CC", name: "Cocos Islands", dial: "+61", flag: "🇨🇨" },
  { code: "CO", name: "Colombia", dial: "+57", flag: "🇨🇴" },
  { code: "KM", name: "Comoros", dial: "+269", flag: "🇰🇲" },
  { code: "CK", name: "Cook Islands", dial: "+682", flag: "🇨🇰" },
  { code: "CR", name: "Costa Rica", dial: "+506", flag: "🇨🇷" },
  { code: "HR", name: "Croatia", dial: "+385", flag: "🇭🇷" },
  { code: "CU", name: "Cuba", dial: "+53", flag: "🇨🇺" },
  { code: "CW", name: "Curaçao", dial: "+599", flag: "🇨🇼" },
  { code: "CY", name: "Cyprus", dial: "+357", flag: "🇨🇾" },
  { code: "CZ", name: "Czech Republic", dial: "+420", flag: "🇨🇿" },
  { code: "CD", name: "Democratic Republic of the Congo", dial: "+243", flag: "🇨🇩" },
  { code: "DK", name: "Denmark", dial: "+45", flag: "🇩🇰" },
  { code: "DJ", name: "Djibouti", dial: "+253", flag: "🇩🇯" },
  { code: "DM", name: "Dominica", dial: "+1-767", flag: "🇩🇲" },
  { code: "DO", name: "Dominican Republic", dial: "+1-809", flag: "🇩🇴" },
  { code: "TL", name: "East Timor", dial: "+670", flag: "🇹🇱" },
  { code: "EC", name: "Ecuador", dial: "+593", flag: "🇪🇨" },
  { code: "EG", name: "Egypt", dial: "+20", flag: "🇪🇬" },
  { code: "SV", name: "El Salvador", dial: "+503", flag: "🇸🇻" },
  { code: "GQ", name: "Equatorial Guinea", dial: "+240", flag: "🇬🇶" },
  { code: "ER", name: "Eritrea", dial: "+291", flag: "🇪🇷" },
  { code: "EE", name: "Estonia", dial: "+372", flag: "🇪🇪" },
  { code: "ET", name: "Ethiopia", dial: "+251", flag: "🇪🇹" },
  { code: "FK", name: "Falkland Islands", dial: "+500", flag: "🇫🇰" },
  { code: "FO", name: "Faroe Islands", dial: "+298", flag: "🇫🇴" },
  { code: "FJ", name: "Fiji", dial: "+679", flag: "🇫🇯" },
  { code: "FI", name: "Finland", dial: "+358", flag: "🇫🇮" },
  { code: "FR", name: "France", dial: "+33", flag: "🇫🇷" },
  { code: "PF", name: "French Polynesia", dial: "+689", flag: "🇵🇫" },
  { code: "GA", name: "Gabon", dial: "+241", flag: "🇬🇦" },
  { code: "GM", name: "Gambia", dial: "+220", flag: "🇬🇲" },
  { code: "GE", name: "Georgia", dial: "+995", flag: "🇬🇪" },
  { code: "DE", name: "Germany", dial: "+49", flag: "🇩🇪" },
  { code: "GH", name: "Ghana", dial: "+233", flag: "🇬🇭" },
  { code: "GI", name: "Gibraltar", dial: "+350", flag: "🇬🇮" },
  { code: "GR", name: "Greece", dial: "+30", flag: "🇬🇷" },
  { code: "GL", name: "Greenland", dial: "+299", flag: "🇬🇱" },
  { code: "GD", name: "Grenada", dial: "+1-473", flag: "🇬🇩" },
  { code: "GU", name: "Guam", dial: "+1-671", flag: "🇬🇺" },
  { code: "GT", name: "Guatemala", dial: "+502", flag: "🇬🇹" },
  { code: "GG", name: "Guernsey", dial: "+44-1481", flag: "🇬🇬" },
  { code: "GN", name: "Guinea", dial: "+224", flag: "🇬🇳" },
  { code: "GW", name: "Guinea-Bissau", dial: "+245", flag: "🇬🇼" },
  { code: "GY", name: "Guyana", dial: "+592", flag: "🇬🇾" },
  { code: "HT", name: "Haiti", dial: "+509", flag: "🇭🇹" },
  { code: "HN", name: "Honduras", dial: "+504", flag: "🇭🇳" },
  { code: "HK", name: "Hong Kong", dial: "+852", flag: "🇭🇰" },
  { code: "HU", name: "Hungary", dial: "+36", flag: "🇭🇺" },
  { code: "IS", name: "Iceland", dial: "+354", flag: "🇮🇸" },
  { code: "IN", name: "India", dial: "+91", flag: "🇮🇳" },
  { code: "ID", name: "Indonesia", dial: "+62", flag: "🇮🇩" },
  { code: "IR", name: "Iran", dial: "+98", flag: "🇮🇷" },
  { code: "IQ", name: "Iraq", dial: "+964", flag: "🇮🇶" },
  { code: "IE", name: "Ireland", dial: "+353", flag: "🇮🇪" },
  { code: "IM", name: "Isle of Man", dial: "+44-1624", flag: "🇮🇲" },
  { code: "IL", name: "Israel", dial: "+972", flag: "🇮🇱" },
  { code: "IT", name: "Italy", dial: "+39", flag: "🇮🇹" },
  { code: "CI", name: "Ivory Coast", dial: "+225", flag: "🇨🇮" },
  { code: "JM", name: "Jamaica", dial: "+1-876", flag: "🇯🇲" },
  { code: "JP", name: "Japan", dial: "+81", flag: "🇯🇵" },
  { code: "JE", name: "Jersey", dial: "+44-1534", flag: "🇯🇪" },
  { code: "JO", name: "Jordan", dial: "+962", flag: "🇯🇴" },
  { code: "KZ", name: "Kazakhstan", dial: "+7", flag: "🇰🇿" },
  { code: "KE", name: "Kenya", dial: "+254", flag: "🇰🇪" },
  { code: "KI", name: "Kiribati", dial: "+686", flag: "🇰🇮" },
  { code: "XK", name: "Kosovo", dial: "+383", flag: "🇽🇰" },
  { code: "KW", name: "Kuwait", dial: "+965", flag: "🇰🇼" },
  { code: "KG", name: "Kyrgyzstan", dial: "+996", flag: "🇰🇬" },
  { code: "LA", name: "Laos", dial: "+856", flag: "🇱🇦" },
  { code: "LV", name: "Latvia", dial: "+371", flag: "🇱🇻" },
  { code: "LB", name: "Lebanon", dial: "+961", flag: "🇱🇧" },
  { code: "LS", name: "Lesotho", dial: "+266", flag: "🇱🇸" },
  { code: "LR", name: "Liberia", dial: "+231", flag: "🇱🇷" },
  { code: "LY", name: "Libya", dial: "+218", flag: "🇱🇾" },
  { code: "LI", name: "Liechtenstein", dial: "+423", flag: "🇱🇮" },
  { code: "LT", name: "Lithuania", dial: "+370", flag: "🇱🇹" },
  { code: "LU", name: "Luxembourg", dial: "+352", flag: "🇱🇺" },
  { code: "MO", name: "Macau", dial: "+853", flag: "🇲🇴" },
  { code: "MK", name: "Macedonia", dial: "+389", flag: "🇲🇰" },
  { code: "MG", name: "Madagascar", dial: "+261", flag: "🇲🇬" },
  { code: "MW", name: "Malawi", dial: "+265", flag: "🇲🇼" },
  { code: "MY", name: "Malaysia", dial: "+60", flag: "🇲🇾" },
  { code: "MV", name: "Maldives", dial: "+960", flag: "🇲🇻" },
  { code: "ML", name: "Mali", dial: "+223", flag: "🇲🇱" },
  { code: "MT", name: "Malta", dial: "+356", flag: "🇲🇹" },
  { code: "MH", name: "Marshall Islands", dial: "+692", flag: "🇲🇭" },
  { code: "MR", name: "Mauritania", dial: "+222", flag: "🇲🇷" },
  { code: "MU", name: "Mauritius", dial: "+230", flag: "🇲🇺" },
  { code: "YT", name: "Mayotte", dial: "+262", flag: "🇾🇹" },
  { code: "MX", name: "Mexico", dial: "+52", flag: "🇲🇽" },
  { code: "FM", name: "Micronesia", dial: "+691", flag: "🇫🇲" },
  { code: "MD", name: "Moldova", dial: "+373", flag: "🇲🇩" },
  { code: "MC", name: "Monaco", dial: "+377", flag: "🇲🇨" },
  { code: "MN", name: "Mongolia", dial: "+976", flag: "🇲🇳" },
  { code: "ME", name: "Montenegro", dial: "+382", flag: "🇲🇪" },
  { code: "MS", name: "Montserrat", dial: "+1-664", flag: "🇲🇸" },
  { code: "MA", name: "Morocco", dial: "+212", flag: "🇲🇦" },
  { code: "MZ", name: "Mozambique", dial: "+258", flag: "🇲🇿" },
  { code: "MM", name: "Myanmar", dial: "+95", flag: "🇲🇲" },
  { code: "NA", name: "Namibia", dial: "+264", flag: "🇳🇦" },
  { code: "NR", name: "Nauru", dial: "+674", flag: "🇳🇷" },
  { code: "NP", name: "Nepal", dial: "+977", flag: "🇳🇵" },
  { code: "NL", name: "Netherlands", dial: "+31", flag: "🇳🇱" },
  { code: "NC", name: "New Caledonia", dial: "+687", flag: "🇳🇨" },
  { code: "NZ", name: "New Zealand", dial: "+64", flag: "🇳🇿" },
  { code: "NI", name: "Nicaragua", dial: "+505", flag: "🇳🇮" },
  { code: "NE", name: "Niger", dial: "+227", flag: "🇳🇪" },
  { code: "NG", name: "Nigeria", dial: "+234", flag: "🇳🇬" },
  { code: "NU", name: "Niue", dial: "+683", flag: "🇳🇺" },
  { code: "KP", name: "North Korea", dial: "+850", flag: "🇰🇵" },
  { code: "MP", name: "Northern Mariana Islands", dial: "+1-670", flag: "🇲🇵" },
  { code: "NO", name: "Norway", dial: "+47", flag: "🇳🇴" },
  { code: "OM", name: "Oman", dial: "+968", flag: "🇴🇲" },
  { code: "PK", name: "Pakistan", dial: "+92", flag: "🇵🇰" },
  { code: "PW", name: "Palau", dial: "+680", flag: "🇵🇼" },
  { code: "PS", name: "Palestine", dial: "+970", flag: "🇵🇸" },
  { code: "PA", name: "Panama", dial: "+507", flag: "🇵🇦" },
  { code: "PG", name: "Papua New Guinea", dial: "+675", flag: "🇵🇬" },
  { code: "PY", name: "Paraguay", dial: "+595", flag: "🇵🇾" },
  { code: "PE", name: "Peru", dial: "+51", flag: "🇵🇪" },
  { code: "PH", name: "Philippines", dial: "+63", flag: "🇵🇭" },
  { code: "PN", name: "Pitcairn", dial: "+64", flag: "🇵🇳" },
  { code: "PL", name: "Poland", dial: "+48", flag: "🇵🇱" },
  { code: "PT", name: "Portugal", dial: "+351", flag: "🇵🇹" },
  { code: "PR", name: "Puerto Rico", dial: "+1-787", flag: "🇵🇷" },
  { code: "QA", name: "Qatar", dial: "+974", flag: "🇶🇦" },
  { code: "CG", name: "Republic of the Congo", dial: "+242", flag: "🇨🇬" },
  { code: "RE", name: "Réunion", dial: "+262", flag: "🇷🇪" },
  { code: "RO", name: "Romania", dial: "+40", flag: "🇷🇴" },
  { code: "RU", name: "Russia", dial: "+7", flag: "🇷🇺" },
  { code: "RW", name: "Rwanda", dial: "+250", flag: "🇷🇼" },
  { code: "BL", name: "Saint Barthélemy", dial: "+590", flag: "🇧🇱" },
  { code: "SH", name: "Saint Helena", dial: "+290", flag: "🇸🇭" },
  { code: "KN", name: "Saint Kitts and Nevis", dial: "+1-869", flag: "🇰🇳" },
  { code: "LC", name: "Saint Lucia", dial: "+1-758", flag: "🇱🇨" },
  { code: "MF", name: "Saint Martin", dial: "+590", flag: "🇲🇫" },
  { code: "PM", name: "Saint Pierre and Miquelon", dial: "+508", flag: "🇵🇲" },
  { code: "VC", name: "Saint Vincent and the Grenadines", dial: "+1-784", flag: "🇻🇨" },
  { code: "WS", name: "Samoa", dial: "+685", flag: "🇼🇸" },
  { code: "SM", name: "San Marino", dial: "+378", flag: "🇸🇲" },
  { code: "ST", name: "São Tomé and Príncipe", dial: "+239", flag: "🇸🇹" },
  { code: "SA", name: "Saudi Arabia", dial: "+966", flag: "🇸🇦" },
  { code: "SN", name: "Senegal", dial: "+221", flag: "🇸🇳" },
  { code: "RS", name: "Serbia", dial: "+381", flag: "🇷🇸" },
  { code: "SC", name: "Seychelles", dial: "+248", flag: "🇸🇨" },
  { code: "SL", name: "Sierra Leone", dial: "+232", flag: "🇸🇱" },
  { code: "SG", name: "Singapore", dial: "+65", flag: "🇸🇬" },
  { code: "SX", name: "Sint Maarten", dial: "+1-721", flag: "🇸🇽" },
  { code: "SK", name: "Slovakia", dial: "+421", flag: "🇸🇰" },
  { code: "SI", name: "Slovenia", dial: "+386", flag: "🇸🇮" },
  { code: "SB", name: "Solomon Islands", dial: "+677", flag: "🇸🇧" },
  { code: "SO", name: "Somalia", dial: "+252", flag: "🇸🇴" },
  { code: "ZA", name: "South Africa", dial: "+27", flag: "🇿🇦" },
  { code: "KR", name: "South Korea", dial: "+82", flag: "🇰🇷" },
  { code: "SS", name: "South Sudan", dial: "+211", flag: "🇸🇸" },
  { code: "ES", name: "Spain", dial: "+34", flag: "🇪🇸" },
  { code: "LK", name: "Sri Lanka", dial: "+94", flag: "🇱🇰" },
  { code: "SD", name: "Sudan", dial: "+249", flag: "🇸🇩" },
  { code: "SR", name: "Suriname", dial: "+597", flag: "🇸🇷" },
  { code: "SZ", name: "Swaziland", dial: "+268", flag: "🇸🇿" },
  { code: "SE", name: "Sweden", dial: "+46", flag: "🇸🇪" },
  { code: "CH", name: "Switzerland", dial: "+41", flag: "🇨🇭" },
  { code: "SY", name: "Syria", dial: "+963", flag: "🇸🇾" },
  { code: "TW", name: "Taiwan", dial: "+886", flag: "🇹🇼" },
  { code: "TJ", name: "Tajikistan", dial: "+992", flag: "🇹🇯" },
  { code: "TZ", name: "Tanzania", dial: "+255", flag: "🇹🇿" },
  { code: "TH", name: "Thailand", dial: "+66", flag: "🇹🇭" },
  { code: "TG", name: "Togo", dial: "+228", flag: "🇹🇬" },
  { code: "TK", name: "Tokelau", dial: "+690", flag: "🇹🇰" },
  { code: "TO", name: "Tonga", dial: "+676", flag: "🇹🇴" },
  { code: "TT", name: "Trinidad and Tobago", dial: "+1-868", flag: "🇹🇹" },
  { code: "TN", name: "Tunisia", dial: "+216", flag: "🇹🇳" },
  { code: "TR", name: "Turkey", dial: "+90", flag: "🇹🇷" },
  { code: "TM", name: "Turkmenistan", dial: "+993", flag: "🇹🇲" },
  { code: "TC", name: "Turks and Caicos Islands", dial: "+1-649", flag: "🇹🇨" },
  { code: "TV", name: "Tuvalu", dial: "+688", flag: "🇹🇻" },
  { code: "VI", name: "U.S. Virgin Islands", dial: "+1-340", flag: "🇻🇮" },
  { code: "UG", name: "Uganda", dial: "+256", flag: "🇺🇬" },
  { code: "UA", name: "Ukraine", dial: "+380", flag: "🇺🇦" },
  { code: "AE", name: "United Arab Emirates", dial: "+971", flag: "🇦🇪" },
  { code: "GB", name: "United Kingdom", dial: "+44", flag: "🇬🇧" },
  { code: "US", name: "United States", dial: "+1", flag: "🇺🇸" },
  { code: "UY", name: "Uruguay", dial: "+598", flag: "🇺🇾" },
  { code: "UZ", name: "Uzbekistan", dial: "+998", flag: "🇺🇿" },
  { code: "VU", name: "Vanuatu", dial: "+678", flag: "🇻🇺" },
  { code: "VA", name: "Vatican City", dial: "+39-06", flag: "🇻🇦" },
  { code: "VE", name: "Venezuela", dial: "+58", flag: "🇻🇪" },
  { code: "VN", name: "Vietnam", dial: "+84", flag: "🇻🇳" },
  { code: "WF", name: "Wallis and Futuna", dial: "+681", flag: "🇼🇫" },
  { code: "EH", name: "Western Sahara", dial: "+212", flag: "🇪🇭" },
  { code: "YE", name: "Yemen", dial: "+967", flag: "🇾🇪" },
  { code: "ZM", name: "Zambia", dial: "+260", flag: "🇿🇲" },
  { code: "ZW", name: "Zimbabwe", dial: "+263", flag: "🇿🇼" }
];

export default function SupportForm() {
  const [open, setOpen] = useState(false);
  const [success, setSuccess] = useState(false);
  const fetcher = useFetcher<{ success: boolean; message: string }>();
  const formRef = useRef<HTMLFormElement>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const lastState = useRef(fetcher.state);

  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  useEffect(() => {
    if (lastState.current !== "idle" && fetcher.state === "idle" && result?.success) {
      setSuccess(true);
      formRef.current?.reset();
    }
    lastState.current = fetcher.state;
  }, [fetcher.state, result]);

  useEffect(() => {
    if (!open) {
      setSuccess(false);
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const handleFillAgain = () => {
    setSuccess(false);
  };

  return (
    <>
      <button
        style={styles.fab}
        onClick={() => setOpen(true)}
        aria-label="Open support form"
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = "scale(1.1)";
          e.currentTarget.style.boxShadow = "0 6px 20px rgba(0,127,239,0.5)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = "scale(1)";
          e.currentTarget.style.boxShadow = "0 4px 14px rgba(0,127,239,0.4)";
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {open && (
        <div
          style={styles.overlay}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div style={styles.modal}>
            <style>{`
              @keyframes sfFadeIn {
                from { opacity: 0; transform: scale(0.95); }
                to { opacity: 1; transform: scale(1); }
              }
            `}</style>

            <button
              style={styles.close}
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ✕
            </button>

            {!success ? (
              <>
                <h2 style={styles.heading}>Support Form</h2>

                {result?.success === false && (
                  <div style={{ ...styles.alert, ...styles.alertError }}>
                    {result.message || "Failed to send message. Please try again."}
                  </div>
                )}

                <fetcher.Form
                  ref={formRef}
                  method="post"
                  action="/api/support-form"
                >
                  <div style={styles.fieldGroup}>
                    <label style={styles.label} htmlFor="sf-name">
                      Name<span style={styles.required}>*</span>
                    </label>
                    <input
                      id="sf-name"
                      name="name"
                      type="text"
                      required
                      style={{
                        ...styles.input,
                        borderColor: focusedField === "name" ? "#007FEF" : "#d1d5db",
                      }}
                      onFocus={() => setFocusedField("name")}
                      onBlur={() => setFocusedField(null)}
                      placeholder="John Doe"
                    />
                  </div>

                  <div style={styles.fieldGroup}>
                    <label style={styles.label} htmlFor="sf-email">
                      Email<span style={styles.required}>*</span>
                    </label>
                    <input
                      id="sf-email"
                      name="email"
                      type="email"
                      required
                      style={{
                        ...styles.input,
                        borderColor: focusedField === "email" ? "#007FEF" : "#d1d5db",
                      }}
                      onFocus={() => setFocusedField("email")}
                      onBlur={() => setFocusedField(null)}
                      placeholder="john@example.com"
                    />
                  </div>

                  <div style={styles.fieldGroup}>
                    <label style={styles.label} htmlFor="sf-phone">
                      Phone<span style={styles.required}>*</span>
                    </label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <select
                        id="sf-countryCode"
                        name="countryCode"
                        required
                        style={{
                          ...styles.countryCodeSelect,
                          borderColor: focusedField === "countryCode" ? "#007FEF" : "#d1d5db",
                        }}
                        onFocus={() => setFocusedField("countryCode")}
                        onBlur={() => setFocusedField(null)}
                        defaultValue="+1"
                      >
                        {COUNTRIES_LIST.map((c) => (
                          <option key={`${c.code}-${c.dial}`} value={c.dial}>
                            {c.flag} {c.dial} ({c.code})
                          </option>
                        ))}
                      </select>
                      <input
                        id="sf-phone"
                        name="phone"
                        type="tel"
                        style={{
                          ...styles.input,
                          borderColor: focusedField === "phone" ? "#007FEF" : "#d1d5db",
                        }}
                        onFocus={() => setFocusedField("phone")}
                        onBlur={() => setFocusedField(null)}
                        placeholder="123-456-7890"
                      />
                    </div>
                  </div>

                  <div style={styles.fieldGroup}>
                    <label style={styles.label} htmlFor="sf-comment">
                      Comment<span style={styles.required}>*</span>
                    </label>
                    <textarea
                      id="sf-comment"
                      name="comment"
                      required
                      style={{
                        ...styles.textarea,
                        borderColor: focusedField === "comment" ? "#007FEF" : "#d1d5db",
                      }}
                      onFocus={() => setFocusedField("comment")}
                      onBlur={() => setFocusedField(null)}
                      placeholder="How can we help you?"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={busy}
                    style={{
                      ...styles.submitBtn,
                      ...(busy ? styles.submitBtnDisabled : {}),
                    }}
                  >
                    {busy ? "Sending..." : "Submit"}
                  </button>
                </fetcher.Form>
              </>
            ) : (
              <div style={styles.successContainer}>
                <div style={styles.successIcon}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </div>
                <h3 style={styles.successHeading}>Thank You!</h3>
                <p style={styles.successText}>
                  Your message has been sent successfully! We'll get back to you soon.
                </p>
                <button
                  type="button"
                  onClick={handleFillAgain}
                  style={styles.fillAgainBtn}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "#007FEF";
                    e.currentTarget.style.color = "#FFFFFF";
                    e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,127,239,0.2)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "#FFFFFF";
                    e.currentTarget.style.color = "#007FEF";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 4v6h-6" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                  Fill Again
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
