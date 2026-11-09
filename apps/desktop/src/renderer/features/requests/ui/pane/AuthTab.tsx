/**
 * Auth (DESIGN.md, Requests → Request pane): none, Bearer or Basic, as written with their
 * `{{variables}}`; secrets stay variables, never typed values Polaris keeps.
 */
import { RequestAuth } from "@polaris/protocol";
import { cn, SegmentedControl } from "@polaris/ui";

type Kind = "none" | "bearer" | "basic";

const kindOf = (auth: RequestAuth | null): Kind =>
  auth === null
    ? "none"
    : RequestAuth.match(auth, { Bearer: () => "bearer", Basic: () => "basic" });

const FIELD =
  "text-caption text-text-default placeholder:text-text-faint h-7 w-full min-w-0 rounded-control bg-well px-2 font-mono outline-none ring-1 ring-inset ring-hairline focus:ring-2 focus:ring-starlight";

const Field = ({
  label,
  value,
  placeholder,
  onValue,
}: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly onValue: (value: string) => void;
}) => (
  <label className="flex items-center gap-3">
    <span className="text-caption text-text-subtle w-20 shrink-0">{label}</span>
    <input
      aria-label={label}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onValue(event.target.value)}
      className={cn(FIELD)}
    />
  </label>
);

const switchTo = (kind: Kind): RequestAuth | null => {
  if (kind === "bearer") return RequestAuth.cases.Bearer.make({ token: "" });

  return kind === "basic" ? RequestAuth.cases.Basic.make({ user: "", password: "" }) : null;
};

export const AuthTab = ({
  auth,
  onAuth,
}: {
  readonly auth: RequestAuth | null;
  readonly onAuth: (auth: RequestAuth | null) => void;
}) => (
  <div className="px-panel flex max-w-[560px] flex-col gap-3 py-3" data-testid="requests-auth">
    <SegmentedControl<Kind>
      aria-label="Auth"
      value={kindOf(auth)}
      onValueChange={(kind) => onAuth(switchTo(kind))}
      options={[
        { value: "none", label: "None" },
        { value: "bearer", label: "Bearer" },
        { value: "basic", label: "Basic" },
      ]}
    />
    {auth === null
      ? null
      : RequestAuth.match(auth, {
          Bearer: (bearer) => (
            <Field
              label="Token"
              value={bearer.token}
              placeholder="{{$dotenv API_TOKEN}}"
              onValue={(token) => onAuth({ ...bearer, token })}
            />
          ),
          Basic: (basic) => (
            <>
              <Field
                label="User"
                value={basic.user}
                placeholder="{{user}}"
                onValue={(user) => onAuth({ ...basic, user })}
              />
              <Field
                label="Password"
                value={basic.password}
                placeholder="{{$dotenv API_PASSWORD}}"
                onValue={(password) => onAuth({ ...basic, password })}
              />
            </>
          ),
        })}
    <p className="text-caption text-text-faint">
      Keep secrets in a variable; the file keeps what you type here.
    </p>
  </div>
);
