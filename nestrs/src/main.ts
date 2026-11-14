import * as nest from "nest";
import { AppModule } from "./app.module";

const app = nest.Create(AppModule);
app.SetGlobalPrefix("/api");
app.SetViews("views/*.html");
const port = nest.envOr("PORT", "3000");
app.Listen(port);
