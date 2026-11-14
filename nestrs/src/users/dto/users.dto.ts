import * as nest from "nest";

export class User {
    id: Int32 = 0 as Int32;
    name: Str = "";
    email: Str = "";
}

export class CreateUserDto {
    name: Str = "";
    email: Str = "";
    Validate(): [Null, Error | null] {
        if (this.name === "") return [null, nest.BadRequestException("name is required")];
        if (this.email === "") return [null, nest.BadRequestException("email is required")];
        return [null, null];
    }
}

export class UpdateUserDto {
    name: Str = "";
    email: Str = "";
    Validate(): [Null, Error | null] {
        return [null, null];
    }
}
