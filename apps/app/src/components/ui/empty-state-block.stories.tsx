import { Alert, AlertDescription, AlertTitle } from "@omnyo/shared-ui/alert";
import { Button } from "@omnyo/shared-ui/button";
import { Card } from "@omnyo/shared-ui/card";
import { EmptyStateBlock } from "@omnyo/shared-ui/empty-state";
import { Icon } from "@omnyo/shared-ui/icon";

export default {
  title: "ui/Empty And Notice States",
};

export function Overview() {
  return (
    <div className="m-6 grid max-w-4xl gap-4 md:grid-cols-2">
      <Card variant="flat">
        <EmptyStateBlock
          icon="Globe"
          tone="error"
          title="This server isn’t answering"
          description="Nothing is listening on localhost:61423 yet. Start the dev server, then try again."
          actions={
            <>
              <Button size="sm">
                <Icon name="RotateCcw" />
                Try again
              </Button>
              <Button size="sm" variant="ghost">
                Open in browser
              </Button>
            </>
          }
        />
      </Card>
      <Card variant="flat">
        <EmptyStateBlock
          icon="Workflow"
          title="No workflow runs yet"
          description="Runs appear here as soon as a workflow starts in this chat."
        />
      </Card>
      <div className="flex flex-col gap-3 md:col-span-2">
        <Alert>
          <Icon name="Info" />
          <AlertTitle>Your copy starts with its schedule off</AlertTitle>
          <AlertDescription>
            Turn it on from the automation once the preview looks right.
          </AlertDescription>
        </Alert>
        <Alert variant="warning">
          <Icon name="AlertTriangle" />
          <AlertTitle>Port 5173 is already in use</AlertTitle>
          <AlertDescription>
            Another process holds it. Stop that process or pick another port.
          </AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <Icon name="AlertCircle" />
          <AlertTitle>The preview command exited with code 1</AlertTitle>
          <AlertDescription>
            Check the server log, fix the error and restart it.
          </AlertDescription>
        </Alert>
        <Alert variant="success">
          <Icon name="CircleCheck" />
          <AlertTitle>Saved a disabled copy</AlertTitle>
          <AlertDescription>
            It lives in your project and runs only when you turn it on.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}
